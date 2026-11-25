import { createWriteStream } from "node:fs"
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { PolicyStore, Redactor, SecretRequests, Serial, Vault, type PermissionBridge, type ShellCaller, type Supply } from "oc-secure-kit"
import {
  ACCESS, APIS, CLIENT_SECRET, contentTypeOf, DEFAULT_AUTH_URL, DEFAULT_REVOKE_URL, DEFAULT_TOKEN_URL, explainApiError, explainSignInError, exportFormat,
  GOOGLE_SECRET_PATTERNS, planRclone, RCLONE_REMOTE, rcloneEnv, REFRESH, requestedScopes, SECRET_NAMES, TOKEN_META, TOKEN_NAMES, type Account, type Api, type Discovery, type Target,
} from "./model.js"
import { refreshGrant, revoke, SignInError, startBrowser, type Endpoint, type Grant, type PendingSignIn } from "./oauth.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-google"
/** Drive: multipart up to 5 MB, resumable above. Resumable chunks must be multiples of 256 KiB. */
export const MULTIPART_LIMIT = 5 * 1024 * 1024
export const CHUNK = 32 * 256 * 1024
const FILE_FIELDS = "id,name,mimeType,size,parents,webViewLink,modifiedTime"

export interface SignInState {
  readonly account: string
  readonly url: string
  readonly expiresAt: number
  status: "waiting" | "done" | "failed"
  error?: string
  readonly flow: PendingSignIn
}

export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) { super(message) }
}

export interface ApiResponse { readonly status: number; readonly data: unknown; readonly headers: Record<string, string> }

export interface ServiceOptions {
  readonly authUrl?: string
  readonly tokenUrl?: string
  readonly revokeUrl?: string
  /** One base URL for all four APIs instead of their Google hosts (tests). */
  readonly apiBase?: string
}

export interface UploadInput {
  /** Replace the content of this existing file instead of creating one. */
  readonly fileId?: string
  readonly name?: string
  readonly parents?: readonly string[]
  /** Target type; application/vnd.google-apps.document|spreadsheet|presentation converts. */
  readonly mimeType?: string
  readonly description?: string
}

export class GoogleService {
  readonly redactor = new Redactor()
  readonly signIns = new Map<string, SignInState>()
  #bridge?: PermissionBridge
  #redactorStale = false
  #refreshing = new Map<string, Serial>()

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    readonly requests: SecretRequests,
    readonly options: Required<Omit<ServiceOptions, "apiBase">> & { apiBase?: string },
  ) {}

  static async open(dir: string, options: ServiceOptions = {}): Promise<GoogleService> {
    const [store, vault, policy, requests] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir), SecretRequests.open(dir)])
    const service = new GoogleService(dir, store, vault, policy, requests, {
      authUrl: options.authUrl ?? DEFAULT_AUTH_URL, tokenUrl: options.tokenUrl ?? DEFAULT_TOKEN_URL, revokeUrl: options.revokeUrl ?? DEFAULT_REVOKE_URL,
      ...(options.apiBase && { apiBase: options.apiBase.replace(/\/+$/, "") }),
    })
    await service.refreshRedactor()
    vault.onChange(() => { service.#redactorStale = true })
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }

  async pick(id: string | undefined): Promise<Account> {
    const accounts = await this.store.list()
    if (id) {
      const found = accounts.find(account => account.id === id || account.email === id.toLowerCase())
      if (!found) throw new Error(`No Google account ${JSON.stringify(id)}. Accounts: ${accounts.map(account => account.id).join(", ") || "(none; create one with google_account_upsert)"}`)
      return found
    }
    if (accounts.length === 1) return accounts[0]!
    const fallback = (await this.store.settings()).defaultAccount
    if (fallback) { const found = accounts.find(account => account.id === fallback); if (found) return found }
    if (!accounts.length) throw new Error("No Google account is configured yet. Create one with google_account_upsert (clientId, email), have the user enter the client secret (google_request_secret), then google_signin.")
    throw new Error(`Several Google accounts exist (${accounts.map(account => account.id).join(", ")}). Pass account=<id>; decide from the conversation or ask the user.`)
  }

  /** The OAuth endpoint for an account; throws a plain explanation when the client ID or secret is missing. */
  async endpoint(account: Account): Promise<Endpoint> {
    if (!account.clientId) throw new Error(`${account.id} has no OAuth client ID yet. The user creates a Desktop app client (Personal mode) and gives you its client ID: google_account_upsert id=${account.id} clientId=….apps.googleusercontent.com`)
    const clientSecret = await this.vault.get(account.id, CLIENT_SECRET)
    if (!clientSecret) throw new Error(`The client secret for ${account.id} is not entered yet. Call google_request_secret account=${account.id}; the user enters it outside the chat.`)
    return { authUrl: this.options.authUrl, tokenUrl: this.options.tokenUrl, revokeUrl: this.options.revokeUrl, clientId: account.clientId, clientSecret }
  }

  async secretStatus(account: Account): Promise<"set" | "unset"> { return (await this.vault.has(account.id, CLIENT_SECRET)) ? "set" : "unset" }

  async setSecret(account: Account, secret: string): Promise<void> {
    const value = secret.trim()
    if (value.length < 10 || /\s/.test(value)) throw new Error("That does not look like an OAuth client secret (it is one word, usually starting with GOCSPX-)")
    await this.vault.set(account.id, CLIENT_SECRET, value)
    await this.requests.remove({ entity: account.id, name: CLIENT_SECRET })
    await this.refreshRedactor()
  }

  // ------------------------------------------------------------------ tokens

  async saveGrant(account: Account, grant: Grant): Promise<void> {
    await this.vault.set(account.id, ACCESS, grant.accessToken)
    if (grant.refreshToken) await this.vault.set(account.id, REFRESH, grant.refreshToken)
    await this.vault.set(account.id, TOKEN_META, JSON.stringify({ expiresAt: grant.expiresAt, scopes: grant.scopes }))
    await this.refreshRedactor()
  }

  async signedIn(account: Account): Promise<boolean> { return this.vault.has(account.id, REFRESH) || this.vault.has(account.id, ACCESS) }

  async granted(account: Account): Promise<string[]> {
    const meta = await this.vault.get(account.id, TOKEN_META)
    return meta ? (JSON.parse(meta) as { scopes?: string[] }).scopes ?? [] : []
  }

  /** A valid access token, refreshed when it is about to expire (or `force`). */
  async accessToken(account: Account, force = false): Promise<string> {
    const serial = this.#refreshing.get(account.id) ?? new Serial()
    this.#refreshing.set(account.id, serial)
    return serial.run(async () => {
      const token = await this.vault.get(account.id, ACCESS)
      const meta = await this.vault.get(account.id, TOKEN_META)
      const expiresAt = meta ? (JSON.parse(meta) as { expiresAt?: number }).expiresAt ?? 0 : 0
      if (token && !force && expiresAt - Date.now() > 5 * 60_000) return token
      const refresh = await this.vault.get(account.id, REFRESH)
      if (!refresh) {
        if (token && !force) return token
        throw new Error(`${account.id} is not signed in to Google. Call google_signin account=${account.id} and give the user the link.`)
      }
      try {
        const grant = await refreshGrant(await this.endpoint(account), refresh)
        await this.saveGrant(account, { ...grant, refreshToken: grant.refreshToken ?? refresh, scopes: grant.scopes.length ? grant.scopes : await this.granted(account) })
        return grant.accessToken
      } catch (error) {
        if (error instanceof SignInError) throw new Error(`${account.id}: ${explainSignInError(error.code, error.description, account)}`)
        throw error
      }
    })
  }

  // ------------------------------------------------------------------ API calls

  /** The absolute URL for a resolved target. */
  href(target: Target): string {
    return `${this.options.apiBase ?? `https://${APIS[target.api].host}`}${target.path}`
  }

  async #fetch(account: Account, href: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const send = async (force: boolean) => fetch(href, { ...init, headers: { authorization: `Bearer ${await this.accessToken(account, force)}`, ...init.headers } })
    const response = await send(false)
    if (response.status !== 401) return response
    await response.body?.cancel()
    return send(true)
  }

  async #fail(account: Account, response: Response, api: Api, what: string): Promise<never> {
    const text = await response.text().catch(() => "")
    let data: unknown = text
    try { data = JSON.parse(text) } catch {}
    const error = (data as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } } | undefined)?.error
    const reason = error?.errors?.[0]?.reason ?? error?.status
    const explained = explainApiError(response.status, data, api)
    const hint = explained ?? (response.status === 403 ? ` (the signed-in user or the granted scopes do not allow this; granted: ${(await this.granted(account)).join(" ") || "unknown"})` : "")
    throw new GoogleApiError(`${what} → ${response.status}${reason ? ` ${reason}` : ""}: ${(error?.message ?? (typeof data === "string" ? data : "")).slice(0, 800)}${explained ? `\n${explained}` : hint}`, response.status, reason)
  }

  async api(account: Account, method: string, target: Target, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
    const m = method.toUpperCase()
    const response = await this.#fetch(account, this.href(target), {
      method: m, redirect: "follow",
      headers: { accept: "application/json", ...(init.body !== undefined && { "content-type": "application/json" }), ...init.headers },
      ...(init.body !== undefined && { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    })
    if (!response.ok) return this.#fail(account, response, target.api, `${m} ${target.path.split("?")[0]}`)
    const type = response.headers.get("content-type") ?? ""
    const text = await response.text()
    const data = /json/.test(type) && text ? (() => { try { return JSON.parse(text) } catch { return text } })() : text || undefined
    return { status: response.status, data, headers: Object.fromEntries(["content-type", "location", "etag", "retry-after"].flatMap(name => response.headers.get(name) ? [[name, response.headers.get(name)!]] : [])) }
  }

  async fileMetadata(account: Account, fileId: string): Promise<{ id: string; name: string; mimeType: string; size?: string }> {
    return (await this.api(account, "GET", { api: "drive", path: `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true` })).data as { id: string; name: string; mimeType: string; size?: string }
  }

  /**
   * Downloads a Drive file to a local path. Binary files: alt=media. Google Docs/Sheets/Slides/Drawings: export to
   * `format` (default docx/xlsx/pptx/png). `to` ending in "/" is a directory: the file's name (+ export extension) is used.
   */
  async download(account: Account, source: { fileId?: string; path?: string }, to: string, format?: string): Promise<{ saved: string; bytes: number; contentType?: string; name?: string; exportedAs?: string }> {
    let target: Target, name: string | undefined, exportedAs: string | undefined
    if (source.fileId) {
      const meta = await this.fileMetadata(account, source.fileId)
      name = meta.name
      const id = encodeURIComponent(meta.id ?? source.fileId)
      if (meta.mimeType === "application/vnd.google-apps.folder" || meta.mimeType === "application/vnd.google-apps.shortcut") throw new Error(`${meta.name} is a ${meta.mimeType.split(".").at(-1)}, not a file: list its contents with google_api GET /drive/v3/files?q='${meta.id}' in parents`)
      if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
        const chosen = exportFormat(meta.mimeType, format)
        exportedAs = chosen.mimeType
        if (!name.toLowerCase().endsWith(`.${chosen.extension}`)) name = `${name}.${chosen.extension}`
        target = { api: "drive", path: `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(chosen.mimeType)}` }
      } else {
        if (format) throw new Error(`${meta.name} is a regular file (${meta.mimeType}); format applies only to Google Docs, Sheets, Slides and Drawings`)
        target = { api: "drive", path: `/drive/v3/files/${id}?alt=media&supportsAllDrives=true` }
      }
    } else if (source.path) {
      target = { api: "drive", path: source.path }
    } else throw new Error("Pass fileId or path")
    if (to.endsWith("/")) to = join(to, (name ?? basename(target.path.split("?")[0]!)).replace(/[/\\\u0000]/g, "_"))
    const response = await this.#fetch(account, this.href(target), { method: "GET", redirect: "follow", headers: {} })
    if (!response.ok || !response.body) {
      if (response.status === 403 && exportedAs) {
        const body = await response.clone().text().catch(() => "")
        if (/exportSizeLimitExceeded|too large to be exported/i.test(body)) throw new GoogleApiError(`Export → 403 exportSizeLimitExceeded: exports are limited to 10 MB. Export a smaller format (pdf, csv for one sheet), read it natively (Docs/Sheets/Slides API), or split the file.`, 403, "exportSizeLimitExceeded")
      }
      return this.#fail(account, response, "drive", `Download ${target.path.split("?")[0]}`)
    }
    await mkdir(dirname(to), { recursive: true })
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(to))
    return { saved: to, bytes: (await stat(to)).size, ...(response.headers.get("content-type") && { contentType: response.headers.get("content-type")! }), ...(name && { name }), ...(exportedAs && { exportedAs }) }
  }

  /** Uploads a local file as a new Drive file or new content for `fileId`. Multipart up to 5 MB, resumable in 8 MiB chunks above. */
  async upload(account: Account, from: string, input: UploadInput): Promise<Record<string, unknown>> {
    const size = (await stat(from)).size
    const contentType = contentTypeOf(from)
    const metadata: Record<string, unknown> = {
      ...(input.name ? { name: input.name } : input.fileId ? {} : { name: basename(from) }),
      ...(input.parents?.length && !input.fileId && { parents: input.parents }),
      ...(input.mimeType && { mimeType: input.mimeType }), ...(input.description && { description: input.description }),
    }
    const method = input.fileId ? "PATCH" : "POST"
    const base = `/upload/drive/v3/files${input.fileId ? `/${encodeURIComponent(input.fileId)}` : ""}`
    const query = `supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`
    if (size <= MULTIPART_LIMIT) {
      const boundary = `oc-google-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        await readFile(from), Buffer.from(`\r\n--${boundary}--`),
      ])
      const target: Target = { api: "drive", path: `${base}?uploadType=multipart&${query}` }
      const response = await this.#fetch(account, this.href(target), { method, headers: { "content-type": `multipart/related; boundary=${boundary}`, accept: "application/json" }, body })
      if (!response.ok) return this.#fail(account, response, "drive", `Upload ${basename(from)}`)
      return await response.json() as Record<string, unknown>
    }
    const start: Target = { api: "drive", path: `${base}?uploadType=resumable&${query}` }
    const init = await this.#fetch(account, this.href(start), {
      method, headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": contentType, "x-upload-content-length": String(size) }, body: JSON.stringify(metadata),
    })
    if (!init.ok) return this.#fail(account, init, "drive", `Start upload of ${basename(from)}`)
    await init.body?.cancel()
    const location = init.headers.get("location")
    if (!location) throw new GoogleApiError("Google did not return a resumable upload session", init.status)
    const session = new URL(location, this.href(start))
    if (session.origin !== new URL(this.href(start)).origin) throw new GoogleApiError(`Unexpected upload session host ${session.host}`, init.status)
    const handle = await open(from, "r")
    try {
      let offset = 0
      while (offset < size) {
        const length = Math.min(CHUNK, size - offset)
        const chunk = Buffer.alloc(length)
        await handle.read(chunk, 0, length, offset)
        const response = await fetch(session.href, { method: "PUT", redirect: "manual", headers: { "content-length": String(length), "content-range": `bytes ${offset}-${offset + length - 1}/${size}` }, body: chunk })
        if (response.status === 308) {
          await response.body?.cancel()
          const range = /bytes=0-(\d+)/.exec(response.headers.get("range") ?? "")
          offset = range ? Number(range[1]) + 1 : 0
          continue
        }
        if (response.ok) return await response.json() as Record<string, unknown>
        return this.#fail(account, response, "drive", `Upload chunk at byte ${offset}`)
      }
      throw new GoogleApiError("The upload ended without a file from Google", 500)
    } finally { await handle.close() }
  }

  // ------------------------------------------------------------------ discovery and sign-in

  async rediscover(account: Account): Promise<Discovery> {
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    try {
      const about = (await this.api(account, "GET", { api: "drive", path: "/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)" })).data as { user?: { displayName?: string; emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }
      const email = about.user?.emailAddress
      const wanted = account.email
      const problem = wanted && email && email.toLowerCase() !== wanted ? `Signed in as ${email}, but this account is set to ${wanted}. Sign in again with ${wanted}, or change the account's email.` : undefined
      const quota = about.storageQuota
      discovery = {
        ...(about.user?.displayName && { name: about.user.displayName }), ...(email && { email }), granted: await this.granted(account),
        ...(quota && { storage: { ...(quota.usage && { usage: Number(quota.usage) }), ...(quota.limit && { limit: Number(quota.limit) }) } }),
        checkedAt: new Date().toISOString(), ...(problem && { error: problem }),
      }
    } catch (error) {
      discovery = { ...(previous ?? {}), error: (error as Error).message.slice(0, 500), checkedAt: new Date().toISOString() }
    }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  async startSignIn(account: Account): Promise<SignInState> {
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.flow.cancel()
    const endpoint = await this.endpoint(account)
    let flow: PendingSignIn
    try { flow = await startBrowser(endpoint, requestedScopes(account), { ...(account.email && { loginHint: account.email }) }) }
    catch (error) { throw new Error(error instanceof SignInError ? explainSignInError(error.code, error.description, account) : (error as Error).message) }
    const state: SignInState = { account: account.id, url: flow.url, expiresAt: flow.expiresAt, status: "waiting", flow }
    this.signIns.set(account.id, state)
    flow.done
      .then(async grant => { await this.saveGrant(account, grant); await this.rediscover(account); state.status = "done" })
      .catch(error => {
        if (state.status !== "waiting") return
        state.status = "failed"
        state.error = error instanceof SignInError ? explainSignInError(error.code, error.description, account) : (error as Error).message
      })
    return state
  }

  /** Forgets the tokens (revoking them at Google when asked; best effort). The client secret stays. */
  async signOut(account: Account, options: { revoke?: boolean } = {}): Promise<void> {
    if (options.revoke) {
      const value = await this.vault.get(account.id, REFRESH) ?? await this.vault.get(account.id, ACCESS)
      const endpoint = await this.endpoint(account).catch(() => undefined)
      if (value && endpoint) await revoke(endpoint, value)
    }
    for (const name of TOKEN_NAMES) await this.vault.delete(account.id, name)
    await this.store.setDiscovery(account.id, undefined)
    await this.refreshRedactor()
  }

  /** Removes an account: revokes its grant (best effort), then deletes its settings, secrets and permissions. */
  async removeAccount(account: Account): Promise<void> {
    this.signIns.get(account.id)?.flow.cancel()
    this.signIns.delete(account.id)
    await this.signOut(account, { revoke: true })
    await this.store.remove(account.id)
    await this.vault.deleteEntity(account.id)
    await this.policy.removeEntity(account.id)
    await this.requests.remove({ entity: account.id })
    await this.refreshRedactor()
  }

  /** The user's own rclone config, if it defines a remote with our name (then we leave rclone alone). */
  async #userDefinesRemote(remote: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const home = env.HOME ?? ""
    const candidates = env.RCLONE_CONFIG ? [env.RCLONE_CONFIG] : [join(env.XDG_CONFIG_HOME || join(home, ".config"), "rclone", "rclone.conf"), join(home, ".rclone.conf")]
    for (const file of candidates) {
      try { if (new RegExp(`^\\s*\\[${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, "m").test(await readFile(file, "utf8"))) return file } catch {}
    }
    return undefined
  }

  /**
   * Supplies the `gdrive:` rclone remote (the signed-in account's OAuth client and token, only in that command's
   * environment, nothing on disk) to rclone commands that use it, after a permission check. Other commands are untouched.
   */
  async prepareCommand(command: string, caller: ShellCaller, env: NodeJS.ProcessEnv = process.env): Promise<Supply | undefined> {
    const plan = planRclone(command)
    if (!plan.uses) return undefined
    const notes: string[] = []
    const ran = "The command ran without the plugin's Google sign-in."
    const conflict = await this.#userDefinesRemote(RCLONE_REMOTE, env)
    if (conflict) return { env: {}, notes: [`Your own rclone config (${conflict}) defines [${RCLONE_REMOTE}], so it is used as it is. To use the plugin's sign-in instead, rename that remote.`], secrets: false }
    if (plan.login) notes.push(`No rclone login is needed for ${RCLONE_REMOTE}: the plugin supplies the signed-in Google account to every rclone command (rclone config reconnect/create would open a browser).`)
    let account: Account
    try { account = await this.pick(/(?:^|\s)OC_GOOGLE_ACCOUNT=([A-Za-z0-9._@-]+)/.exec(command)?.[1]) }
    catch (error) { return { env: {}, notes: [...notes, `${(error as Error).message} ${ran}`], secrets: false } }
    if (!(await this.signedIn(account))) return { env: {}, notes: [...notes, `${account.id} is not signed in: google_signin account=${account.id}. ${ran}`], secrets: false }
    const metadata = { command: command.length > 300 ? `${command.slice(0, 300)}…` : command, account: account.email ?? account.id }
    for (const capability of plan.kinds) {
      try { await this.bridge.check({ sessionID: caller.sessionID, ...(caller.agent && { agent: caller.agent }), ...(caller.source && { source: caller.source }), capability, entities: [account.id], metadata }) }
      catch (error) { return { env: {}, notes: [...notes, `${capability} on ${account.id}: not granted (${(error as Error).message.split("\n")[0]}). ${ran}`], secrets: false } }
    }
    try {
      const accessToken = await this.accessToken(account)
      const meta = await this.vault.get(account.id, TOKEN_META)
      const expiresAt = meta ? (JSON.parse(meta) as { expiresAt?: number }).expiresAt ?? Date.now() + 30 * 60_000 : Date.now() + 30 * 60_000
      const { clientSecret } = await this.endpoint(account)
      const readOnly = !requestedScopes(account).includes("https://www.googleapis.com/auth/drive")
      const supplied = rcloneEnv(RCLONE_REMOTE, account.clientId!, clientSecret, accessToken, await this.vault.get(account.id, REFRESH), expiresAt, readOnly)
      return { env: supplied, notes, secrets: true, mask: GOOGLE_SECRET_PATTERNS }
    } catch (error) {
      return { env: {}, notes: [...notes, `${(error as Error).message} ${ran}`], secrets: false }
    }
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }
  async refreshRedactor(): Promise<void> {
    this.redactor.replaceAll((await this.vault.values()).filter(item => item.name !== TOKEN_META && (SECRET_NAMES as readonly string[]).includes(item.name)).map(item => [`${item.entity}/${item.name}`, item.value] as const))
  }

  dispose(): void { for (const state of this.signIns.values()) state.flow.cancel() }
}
