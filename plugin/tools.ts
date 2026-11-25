import type { ToolContext } from "@opencode/plugin/promise/tool"
import { isAbsolute, resolve } from "node:path"
import { APIS, classifyRequest, CLIENT_SECRET, CONVERT, mergeAccount, normalizeAccount, PERSONAL_MODE_URL, requestedScopes, resolveApi, SETUP_STEPS, validAccountId, type Account, type Api, type Discovery } from "./model.js"
import type { GoogleService } from "./service.js"

export const TOOL_NAMES = [
  "google_list", "google_api", "google_download", "google_upload",
  "google_account_upsert", "google_account_remove", "google_signin", "google_refresh", "google_request_secret",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

const MAX_OUTPUT = 60_000
const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const ACCOUNT = { type: "string", description: "Account id (optional when there is only one account)" }
const ALLOWED_HEADERS = /^(if-match|if-none-match)$/i

export const USAGE = [
  "Load the 'google' skill before non-trivial Google Drive, Docs, Sheets or Slides work.",
  "google_api calls the Drive v3, Docs, Sheets and Slides REST APIs as the user (e.g. api=drive GET files with q, fields, pageSize; api=docs GET documents/{id}; api=sheets GET spreadsheets/{id}/values/Sheet1!A1:D20). Always pass fields= on Drive to keep results small. google_download / google_upload move files (export Docs/Sheets/Slides to docx, xlsx, pptx, pdf, md, csv …; upload can convert to Google formats).",
  "Changing who has access (sharing, ownership) and permanent deletes ask the user by default; trashing is an ordinary edit.",
].join("\n")

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`

function describe(account: Account, discovery: Discovery | undefined): string {
  const who = discovery?.email ? `${discovery.name ?? discovery.email} <${discovery.email}>` : "not signed in"
  const storage = discovery?.storage?.usage !== undefined ? `; ${gb(discovery.storage.usage)}${discovery.storage.limit ? ` of ${gb(discovery.storage.limit)}` : ""} used` : ""
  return `  ${account.id}: ${who}${storage}${account.preset === "read" ? " (read only)" : ""}${account.label ? ` (${account.label})` : ""}${discovery?.error ? ` [problem: ${discovery.error.slice(0, 160)}]` : ""}`
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>): string {
  if (!accounts.length) return "No Google accounts are configured yet. Setup: the user creates a Desktop app OAuth client in Personal mode, then google_account_upsert (clientId, email) → google_request_secret → google_signin."
  return ["Google accounts (Drive, Docs, Sheets, Slides):", ...accounts.map(account => describe(account, discovery[account.id]))].join("\n")
}

const clip = (text: string) => text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} characters; use fields=, a smaller pageSize or range, or google_download]` : text
const summarize = (value: unknown) => { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > 600 ? `${text.slice(0, 600)}…` : text }

export function withQuery(path: string, query: Record<string, string | number | boolean> | undefined): string {
  if (!query || !Object.keys(query).length) return path
  const [base, existing = ""] = path.split("?")
  const params = new URLSearchParams(existing)
  for (const [key, value] of Object.entries(query)) params.set(key, String(value))
  return `${base}?${params.toString().replace(/\+/g, "%20")}`
}

export function createTools(service: GoogleService, sessionDirectory: (sessionID: string) => Promise<string | undefined> = async () => undefined): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })
  const localPath = async (path: string, context: ToolContext) => {
    if (isAbsolute(path)) return path
    const base = await sessionDirectory(context.sessionID).catch(() => undefined)
    if (!base) throw new Error("Pass an absolute local path (the session directory is unknown)")
    return resolve(base, path) + (/[/\\]$/.test(path) ? "/" : "")
  }
  const tellSecret = (account: Account) => `Please enter the OAuth client secret of ${account.id}'s Desktop app client (${account.clientId ?? "client ID not set yet"}) in OpenCode: Settings → Google (or /google in a session) → Enter client secret, or in a terminal in the oc-google folder: pixi run secret-set ${account.id}. It is shown when the client is created at ${PERSONAL_MODE_URL}; if you no longer have it, add a new secret to the client in Google Auth Platform → Clients.`

  return [
    {
      name: "google_list",
      description: () => {
        const { accounts, discovery } = service.store.cached()
        return `${inventory(accounts, discovery)}\n${USAGE}\nCall this tool for details: granted scopes and what you may do (allow / ask = the user is prompted / deny).`
      },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const settings = await service.store.settings()
        const accounts = await Promise.all((await service.store.list()).map(async account => {
          const signedIn = await service.signedIn(account)
          const discovery = signedIn ? await service.rediscover(account) : await service.store.discovery(account.id)
          const may = Object.fromEntries(await Promise.all(["read", "write", "share", "delete"].map(async capability =>
            [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const)))
          const signIn = service.signIns.get(account.id)
          const secret = await service.secretStatus(account)
          const next = !account.clientId ? `ask the user for the client ID, then google_account_upsert id=${account.id} clientId=…`
            : secret === "unset" ? `google_request_secret account=${account.id}` : !signedIn ? `google_signin account=${account.id}` : undefined
          return {
            id: account.id, ...(account.email && { email: account.email }), ...(account.label && { label: account.label }), preset: account.preset,
            clientId: account.clientId ?? null, clientSecret: secret, signedIn,
            signedInAs: discovery?.email ? `${discovery.name ?? discovery.email} <${discovery.email}>` : null,
            ...(discovery?.storage && { storageBytes: discovery.storage }),
            grantedScopes: await service.granted(account), requested: requestedScopes(account),
            ...(signIn?.status === "waiting" && { signIn: `waiting for the user: ${signIn.url}` }),
            ...(signIn?.status === "failed" && { signInFailed: signIn.error }), ...(discovery?.error && { problem: discovery.error }),
            ...(settings.defaultAccount === account.id && { default: true }), youMay: may, ...(next && { next }),
          }
        }))
        return json({ accounts, usage: USAGE, ...(!accounts.length && { setup: SETUP_STEPS }) })
      },
    },
    {
      name: "google_api",
      description: () => "Call the Google Drive v3, Docs v1, Sheets v4 or Slides v1 REST API as the signed-in user. api: drive|docs|sheets|slides with a path relative to it (files, files/{id}, documents/{id}:batchUpdate, spreadsheets/{id}/values/A1:C9), or a full path (/drive/v3/…, /upload/drive/v3/…, /v1/documents/…, /v4/spreadsheets/…, /v1/presentations/…). query: URL parameters (q, fields, pageSize, pageToken, supportsAllDrives, valueInputOption, …). body: JSON. headers: If-Match / If-None-Match only. Sharing changes and permanent deletes ask the user by default.",
      input: {
        type: "object",
        properties: {
          account: ACCOUNT, api: { type: "string", enum: Object.keys(APIS) }, method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
          path: { type: "string", minLength: 1, maxLength: 4000 }, query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
          body: {}, headers: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["path"], additionalProperties: false,
      },
      execute: async (input: { account?: string; api?: Api; method?: string; path: string; query?: Record<string, string | number | boolean>; body?: unknown; headers?: Record<string, string> }, context) => {
        const account = await service.pick(input.account)
        const method = (input.method ?? "GET").toUpperCase()
        for (const name of Object.keys(input.headers ?? {})) if (!ALLOWED_HEADERS.test(name)) throw new Error(`Header ${name} is not allowed (allowed: If-Match, If-None-Match)`)
        const resolved = resolveApi(input.path, input.api)
        const target = { ...resolved, path: withQuery(resolved.path, input.query) }
        const kind = classifyRequest(method, target)
        await check(context, kind, account.id, { request: `${method} ${target.api} ${target.path}`.slice(0, 500), ...(input.body !== undefined && { body: summarize(input.body) }), account: account.email ?? account.id })
        const result = await service.api(account, method, target, { ...(input.body !== undefined && { body: input.body }), ...(input.headers && { headers: input.headers }) })
        const data = result.data === undefined ? { status: result.status, ...(result.headers.location && { location: result.headers.location }) } : result.data
        return { content: clip(typeof data === "string" ? data : JSON.stringify(data, null, 2)) }
      },
    },
    {
      name: "google_download",
      description: () => "Download a Drive file to a local file (streamed). fileId: regular files are downloaded as they are; Google Docs, Sheets, Slides and Drawings are exported to format (default docx, xlsx, pptx, png; also pdf, md, txt, html, csv/tsv (first sheet only), odt, ods, odp, rtf, epub, jpg, svg). Exports are limited to 10 MB. path: a raw Drive path instead, e.g. /drive/v3/files/{id}/revisions/{rev}?alt=media. to: local path (relative to the session directory; ending in / = that folder, keeping the file name).",
      input: {
        type: "object",
        properties: {
          account: ACCOUNT, fileId: { type: "string", minLength: 1, maxLength: 200 }, path: { type: "string", minLength: 1, maxLength: 4000 },
          format: { type: "string", maxLength: 120, description: "Export format for Google-native files: an extension (pdf, md, docx, csv, …) or a MIME type" },
          to: { type: "string", minLength: 1, maxLength: 1000 },
        },
        required: ["to"], additionalProperties: false,
      },
      execute: async (input: { account?: string; fileId?: string; path?: string; format?: string; to: string }, context) => {
        const account = await service.pick(input.account)
        if (!!input.fileId === !!input.path) throw new Error("Pass exactly one of fileId or path")
        let path: string | undefined
        if (input.path) {
          const target = resolveApi(input.path, "drive")
          if (target.api !== "drive") throw new Error("path must be a Drive path (/drive/v3/…)")
          path = target.path
        }
        await check(context, "read", account.id, { request: `download ${input.fileId ?? path}${input.format ? ` as ${input.format}` : ""}`, to: input.to })
        const to = await localPath(input.to, context)
        return json(await service.download(account, { ...(input.fileId && { fileId: input.fileId }), ...(path && { path }) }, to, input.format))
      },
    },
    {
      name: "google_upload",
      description: () => "Upload a local file to Google Drive (any size). New file: name (default: the local name), parents (folder IDs; default My Drive root). Or fileId to replace an existing file's content (keeps its ID, sharing and history). convert: document|spreadsheet|presentation turns Word/Markdown/HTML/text, Excel/CSV or PowerPoint into a native Google file (or pass mimeType application/vnd.google-apps.*). Replacing a Google Doc/Sheet/Slides with converted content replaces all of its content.",
      input: {
        type: "object",
        properties: {
          account: ACCOUNT, from: { type: "string", minLength: 1, maxLength: 1000 }, fileId: { type: "string", minLength: 1, maxLength: 200 },
          name: { type: "string", minLength: 1, maxLength: 1000 }, parents: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 1 },
          convert: { type: "string", enum: Object.keys(CONVERT) }, mimeType: { type: "string", maxLength: 200 }, description: { type: "string", maxLength: 4000 },
        },
        required: ["from"], additionalProperties: false,
      },
      execute: async (input: { account?: string; from: string; fileId?: string; name?: string; parents?: string[]; convert?: keyof typeof CONVERT; mimeType?: string; description?: string }, context) => {
        const account = await service.pick(input.account)
        if (input.convert && input.mimeType && input.mimeType !== CONVERT[input.convert]) throw new Error("Pass convert or mimeType, not both")
        if (input.fileId && input.parents?.length) throw new Error("parents applies to new files; move an existing file with google_api PATCH files/{id}?addParents=…&removeParents=…")
        const mimeType = input.convert ? CONVERT[input.convert] : input.mimeType
        await check(context, "write", account.id, { request: `upload ${input.from} → ${input.fileId ? `replace ${input.fileId}` : `new ${input.name ?? input.from}${input.parents?.length ? ` in ${input.parents.join(",")}` : ""}`}${mimeType ? ` as ${mimeType}` : ""}` })
        const file = await service.upload(account, await localPath(input.from, context), {
          ...(input.fileId && { fileId: input.fileId }), ...(input.name && { name: input.name }), ...(input.parents && { parents: input.parents }),
          ...(mimeType && { mimeType }), ...(input.description && { description: input.description }),
        })
        return json({ uploaded: file })
      },
    },
    {
      name: "google_account_upsert",
      description: () => "Create or update a Google account (fields merge; null clears). clientId: the OAuth client ID of the user's own Desktop app client (Personal mode), ….apps.googleusercontent.com. email: the Google account (pre-fills sign-in). preset: full (read and write Drive, Docs, Sheets, Slides) or read; custom with scopes=[…]. Never pass the client secret or any token here: the user enters the secret after google_request_secret.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Name chosen by the user, e.g. personal" },
          rename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
          clientId: { type: ["string", "null"] }, email: { type: ["string", "null"] },
          preset: { type: "string", enum: ["full", "read", "custom"] }, scopes: { type: ["array", "null"], items: { type: "string" } },
          label: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
        },
        required: ["id"], additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) { await service.vault.renameEntity(id, target); await service.policy.renameEntity(id, target); await service.requests.remove({ entity: id }) }
        if (existing && existing.clientId !== saved.clientId) { await service.signOut(saved); await service.vault.delete(saved.id, CLIENT_SECRET); await service.refreshRedactor() }
        else if (existing && requestedScopes(existing).join() !== requestedScopes(saved).join()) await service.signOut(saved)
        const secret = await service.secretStatus(saved)
        const signedIn = await service.signedIn(saved)
        const next = !saved.clientId ? `the user creates a Desktop app OAuth client at ${PERSONAL_MODE_URL}; then google_account_upsert id=${saved.id} clientId=…`
          : secret === "unset" ? `ask the user for the client secret: google_request_secret account=${saved.id}` : !signedIn ? `sign in: google_signin account=${saved.id}` : undefined
        return json({ saved, clientSecret: secret, signedIn, ...(next && { next }), ...(!saved.clientId && { setup: SETUP_STEPS }) })
      },
    },
    {
      name: "google_account_remove",
      description: () => "Delete a Google account from this plugin with its stored client secret, sign-in and permission settings (and revoke the plugin's access at Google). Asks the user by default. Does not change any files.",
      input: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
      execute: async (input: { account: string }, context) => {
        const account = await service.pick(input.account)
        await check(context, "remove", account.id)
        await service.removeAccount(account)
        return json({ removed: account.id })
      },
    },
    {
      name: "google_signin",
      description: () => "Start the Google sign-in in the browser on this computer (a local redirect to 127.0.0.1). Needs the clientId and the client secret first. Completes in the background once the user approves; wait blocks up to that many seconds.",
      input: { type: "object", properties: { account: ACCOUNT, wait: { type: "integer", minimum: 0, maximum: 600 } }, additionalProperties: false },
      execute: async (input: { account?: string; wait?: number }, context) => {
        const account = await service.pick(input.account)
        await check(context, "manage", account.id, { operation: "sign in" })
        const state = await service.startSignIn(account)
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (state.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = state.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, status: state.status,
          ...(state.status === "waiting" && { tellUser: `Open this link on this computer and sign in${account.email ? ` as ${account.email}` : ""} (the Google account that created the OAuth client), then allow access: ${state.url}  — or click Sign in in OpenCode's Google view.` }),
          ...(state.error && { error: state.error }),
          ...(discovery && { signedInAs: discovery.email ? `${discovery.name ?? discovery.email} <${discovery.email}>` : null, granted: discovery.granted, ...(discovery.error && { problem: discovery.error }) }),
        })
      },
    },
    {
      name: "google_refresh",
      description: () => "Check an account again: who is signed in, granted scopes, storage used (after signing in, enabling an API, or when something failed).",
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }) => {
        const account = await service.pick(input.account)
        return json({ account: account.id, ...(await service.rediscover(account)) })
      },
    },
    {
      name: "google_request_secret",
      description: () => "Ask the user to enter the OAuth client secret of an account's Desktop app client. They enter it outside the chat (OpenCode's Google view or a terminal); you only learn whether it is set. Never ask for it in the chat.",
      input: { type: "object", properties: { account: ACCOUNT, purpose: { type: "string", maxLength: 300 } }, additionalProperties: false },
      execute: async (input: { account?: string; purpose?: string }, context) => {
        const account = await service.pick(input.account)
        if (!account.clientId) throw new Error(`Set the client ID first: google_account_upsert id=${account.id} clientId=….apps.googleusercontent.com`)
        await service.requests.add({ entity: account.id, name: CLIENT_SECRET, purpose: input.purpose ?? "", sessionID: context.sessionID })
        return json({ status: (await service.secretStatus(account)) === "set" ? "set (the user may replace it)" : "unset", tellUser: tellSecret(account), then: `google_signin account=${account.id}` })
      },
    },
  ]
}
