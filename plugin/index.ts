import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { installRedaction, PermissionBridge, pluginDataDir, SECURE_KIT_VERSION, sessionRoots, ShellSupplier, type PermissionHost } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import { defaultEffect } from "./model.js"
import { GoogleRpc } from "./rpc.js"
import { GoogleService, PLUGIN_ID } from "./service.js"
import { createTools, TOOL_NAMES } from "./tools.js"

export { PLUGIN_ID, SECURE_KIT_VERSION }

export interface GoogleOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-google`. */
  readonly dataDirectory?: string
  /** Authorization endpoint; default https://accounts.google.com/o/oauth2/v2/auth. For tests. */
  readonly authUrl?: string
  /** Token endpoint; default https://oauth2.googleapis.com/token. For tests. */
  readonly tokenUrl?: string
  /** Revocation endpoint; default https://oauth2.googleapis.com/revoke. For tests. */
  readonly revokeUrl?: string
  /** One base URL serving the Drive, Docs, Sheets and Slides paths instead of Google's hosts. For tests. */
  readonly apiBase?: string
}

const KEYS = ["dataDirectory", "authUrl", "tokenUrl", "revokeUrl", "apiBase"] as const
const URLS = ["authUrl", "tokenUrl", "revokeUrl", "apiBase"] as const

export function parseOptions(raw: unknown): GoogleOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  for (const key of KEYS) if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${PLUGIN_ID}: ${key} must be a string`)
  for (const key of URLS) if (options[key] !== undefined && !/^https?:\/\//.test(options[key] as string)) throw new Error(`${PLUGIN_ID}: ${key} must be an http(s) URL`)
  return Object.fromEntries(KEYS.filter(key => options[key] !== undefined).map(key => [key, options[key]])) as GoogleOptions
}

const SKILL = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url))
const warn = (message: string, error?: unknown) =>
  console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const { dataDirectory, ...endpoints } = parseOptions(ctx.options)
        const service = await GoogleService.open(pluginDataDir(PLUGIN_ID, dataDirectory), endpoints)
        registrations.push({ dispose: () => service.dispose() })
        const root = sessionRoots(async sessionID => (await ctx.session.get({ sessionID: sessionID as never })).parentID ?? undefined)
        const bridge = new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, root })
        registrations.push(await bridge.install(ctx.permission as unknown as PermissionHost))
        registrations.push(bridge.followReplies(ctx.event as never, error => warn("could not save Allow always", error)))
        service.attach(bridge)

        const tools = createTools(service, async sessionID => { const session = await ctx.session.get({ sessionID: sessionID as never }); return [session.location.directory, session.subpath].filter(Boolean).join("/") || undefined })
        registrations.push(await ctx.tool.transform(editor => {
          for (const tool of tools) {
            editor.add({
              name: tool.name, description: tool.description(), input: tool.input as never, options: { codemode: false },
              execute: async (input, context) => {
                try { return await tool.execute(input, context) }
                finally { await service.syncRedactor().catch(error => warn("redactor refresh failed", error)) }
              },
            })
          }
        }))
        registrations.push(await installRedaction(ctx.tool as never, service.redactor, new Set<string>(TOOL_NAMES), error => warn("redaction skipped", error)))

        // rclone commands that use the gdrive: remote get the signed-in account; nothing else is touched.
        const shell = new ShellSupplier({
          plugin: PLUGIN_ID, redactor: service.redactor, warn,
          prepare: (command, caller) => service.prepareCommand(command, caller),
          annotate: command => /\brclone\b[^\n]*\b(config\s+(create|reconnect)|authorize)\b/.test(command) ? "No rclone login is needed for Google Drive: use the gdrive: remote, which the oc-google plugin supplies with the signed-in account." : undefined,
        })
        registrations.push({ dispose: () => shell.dispose() })
        registrations.push(await ctx.tool.hook("execute.before", event => shell.before(event)))
        registrations.push(await ctx.shell.hook("create.before", event => shell.create(event)))
        registrations.push(await ctx.tool.hook("execute.after", event => shell.after(event as never)))

        try {
          const content = await readFile(SKILL, "utf8")
          const description = /^description:\s*(.+)$/m.exec(content)?.[1] ?? "Google Drive, Docs, Sheets and Slides know-how"
          registrations.push(await ctx.skill.transform(editor => {
            editor.add({ id: "google" as never, name: "google" as never, description, path: SKILL as never, content })
          }))
        } catch (error) { warn("skill not registered", error) }

        let reloading: Promise<void> | undefined
        registrations.push({ dispose: service.store.onChange(() => {
          reloading ??= Promise.resolve().then(() => ctx.tool.reload()).catch(error => warn("tool reload failed", error)).finally(() => { reloading = undefined })
        }) })

        const admin = createAdmin({
          service, root,
          agents: async () => ((await ctx.agent.list()).data ?? []).filter(agent => !agent.hidden).map(agent => ({ id: agent.id as string, name: agent.name, mode: agent.mode })),
        })
        const handlers = Object.fromEntries(Object.keys(GoogleRpc.methods).map(name => [name, async (input: unknown) => (admin as Record<string, (input: never) => Promise<unknown>>)[name]!(input as never)]))
        registrations.push(await ctx.rpc.register(GoogleRpc, handlers as never))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
