import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-google-accounts/1"

export const DEFAULT_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const DEFAULT_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
/** Where the user creates a Personal-mode OAuth client (Desktop app). */
export const PERSONAL_MODE_URL = "https://console.cloud.google.com/auth/overview/personal"
export const API_LIBRARY_URL = "https://console.cloud.google.com/apis/library"

const AUTH = "https://www.googleapis.com/auth/"
/** Scopes per preset. */
export const SCOPE_PRESETS = {
  full: ["openid", "email", `${AUTH}drive`, `${AUTH}documents`, `${AUTH}spreadsheets`, `${AUTH}presentations`],
  read: ["openid", "email", `${AUTH}drive.readonly`, `${AUTH}documents.readonly`, `${AUTH}spreadsheets.readonly`, `${AUTH}presentations.readonly`],
} as const
export type Preset = keyof typeof SCOPE_PRESETS | "custom"

/** The four APIs the plugin talks to, with the host each lives on and the path prefix that selects it. */
export const APIS = {
  drive: { host: "www.googleapis.com", prefix: "/drive/v3", service: "drive.googleapis.com", title: "Google Drive API" },
  docs: { host: "docs.googleapis.com", prefix: "/v1", service: "docs.googleapis.com", title: "Google Docs API" },
  sheets: { host: "sheets.googleapis.com", prefix: "/v4", service: "sheets.googleapis.com", title: "Google Sheets API" },
  slides: { host: "slides.googleapis.com", prefix: "/v1", service: "slides.googleapis.com", title: "Google Slides API" },
} as const
export type Api = keyof typeof APIS

export interface Account {
  readonly id: string
  readonly label?: string
  /** OAuth client ID of the user's own Desktop-app client, `….apps.googleusercontent.com`. Not secret. */
  readonly clientId?: string
  /** Which access to request. */
  readonly preset: Preset
  /** For preset=custom: the scopes. */
  readonly scopes?: readonly string[]
  /** The Google account (pre-fills sign-in; checked after sign-in). */
  readonly email?: string
  readonly notes?: string
  readonly updatedAt: string
}

export interface Discovery {
  readonly name?: string
  readonly email?: string
  readonly granted?: readonly string[]
  /** Bytes. limit is absent for unlimited storage. */
  readonly storage?: { readonly usage?: number; readonly limit?: number }
  readonly checkedAt?: string
  readonly error?: string
}

/**
 * What a request does:
 * - read: look at files, documents, sheets, slides, metadata, comments, permissions.
 * - write: create, edit, copy, move, rename, upload, trash/untrash, comment.
 * - share: anything that changes who has access (permissions, ownership transfer, access requests).
 * - delete: permanent deletion (files, empty trash, revisions, shared drives, comments).
 */
export const KINDS = ["read", "write", "share", "delete"] as const
export type Kind = (typeof KINDS)[number]
export const CAPABILITIES = [...KINDS, "manage", "remove"] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Starting point only; users change it in the table. Own reads and edits run; sharing, permanent deletes and removing an account ask. */
export function defaultEffect(capability: string): "allow" | "ask" {
  return ["share", "delete", "remove"].includes(capability) ? "ask" : "allow"
}

export const CLIENT_SECRET = "client-secret"
export const ACCESS = "access-token"
export const REFRESH = "refresh-token"
/** { expiresAt, scopes } for the stored tokens. */
export const TOKEN_META = "token-meta"
export const SECRET_NAMES = [CLIENT_SECRET, ACCESS, REFRESH, TOKEN_META] as const
export const TOKEN_NAMES = [ACCESS, REFRESH, TOKEN_META] as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const CLIENT_ID = /^[0-9]{3,30}-[a-z0-9_]{8,64}\.apps\.googleusercontent\.com$/
const SCOPE = /^(openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]+)$/
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return (value as string).trim()
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  return validName("account", id)
}

export function validClientId(value: string): string {
  if (!CLIENT_ID.test(value)) fail("clientId must be an OAuth client ID like 123456789012-abc123def456.apps.googleusercontent.com (from the Desktop app client you created; the client secret is entered separately)")
  return value
}

/** Expands the short forms drive.readonly, documents, … to full scope URLs. */
export function expandScope(scope: string): string {
  return /^(openid|email|profile)$/.test(scope) || scope.startsWith("https://") ? scope : `${AUTH}${scope}`
}

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!["id", "label", "clientId", "preset", "scopes", "email", "notes", "updatedAt"].includes(key)) fail(`Unknown account field ${JSON.stringify(key)}${/secret|token|password/i.test(key) ? " (secrets are never passed here: use google_request_secret)" : ""}`)
  const id = validAccountId(raw.id)
  const clientId = text(raw.clientId, "clientId", 120)
  if (clientId !== undefined) validClientId(clientId)
  const preset = (raw.preset ?? "full") as Preset
  if (!["full", "read", "custom"].includes(preset)) fail("preset must be full, read or custom")
  let scopes: string[] | undefined
  if (raw.scopes !== undefined && raw.scopes !== null) {
    if (!Array.isArray(raw.scopes) || raw.scopes.length > 40 || raw.scopes.some(scope => typeof scope !== "string")) fail("scopes must be a list of Google OAuth scopes")
    scopes = [...new Set((raw.scopes as string[]).map(scope => expandScope(scope.trim())))]
    for (const scope of scopes) if (!SCOPE.test(scope)) fail(`${JSON.stringify(scope)} is not a Google OAuth scope (e.g. https://www.googleapis.com/auth/drive.readonly, or drive.readonly)`)
  }
  if (preset === "custom" && !scopes?.length) fail("preset custom needs scopes")
  const email = text(raw.email, "email", 254)?.toLowerCase()
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("email is not an email address")
  const label = text(raw.label, "label", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return {
    id, preset, ...(clientId && { clientId }), ...(preset === "custom" && scopes && { scopes }), ...(email && { email }),
    ...(label && { label }), ...(notes && { notes }), updatedAt: now.toISOString(),
  }
}

export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

/** The scopes an account requests. */
export function requestedScopes(account: Account): string[] {
  return [...(account.preset === "custom" ? account.scopes ?? [] : SCOPE_PRESETS[account.preset])]
}

/** Short setup steps, shown by tools and the GUI. */
export const SETUP_STEPS = [
  `1. Open ${PERSONAL_MODE_URL} signed in as the Google account to use, choose application type "Desktop app", accept the terms and click Continue. Copy the Client ID and the Client secret (the secret is shown only once).`,
  `2. Enable the Google Drive, Docs, Sheets and Slides APIs for that project in ${API_LIBRARY_URL} (search each name, click Enable).`,
  "3. In OpenCode: google_account_upsert with the clientId (and email), enter the client secret when asked (google_request_secret, or the Google view in Settings), then google_signin.",
]

/** Explains Google sign-in errors in plain words. */
export function explainSignInError(code: string | undefined, description: string | undefined, account: Account): string {
  const text = `${code ?? ""} ${description ?? ""}`
  if (/client_user_mismatch/i.test(text)) return `This OAuth client is in Personal mode and only the Google account that created it can sign in${account.email ? ` (this account is set to ${account.email})` : ""}. Sign in with the creator account, or create your own client at ${PERSONAL_MODE_URL} and set its clientId.`
  if (/access_denied/i.test(text)) return "The sign-in was declined (access_denied): access was not granted. Sign in again and allow access."
  if (/admin_policy_enforced/i.test(text)) return "Your Google Workspace administrator does not allow this app to use these scopes (admin_policy_enforced). Ask the admin to trust the OAuth client, or use a personal Google account."
  if (/org_internal/i.test(text)) return "This OAuth client only allows accounts of its Google Cloud organization (org_internal). Use a Personal-mode client created by the account you sign in with."
  if (/deleted_client/i.test(text)) return `The OAuth client was deleted (deleted_client). Restore it within 30 days in the Google Cloud console (Google Auth Platform → Clients), or create a new one at ${PERSONAL_MODE_URL} and update clientId and the secret.`
  if (/invalid_client|unauthorized_client/i.test(text)) return `Google does not accept the client ID and secret (${code}). Check that clientId and the client secret belong to the same OAuth client and that its type is "Desktop app"; enter the secret again (google_request_secret).`
  if (/redirect_uri_mismatch/i.test(text)) return `Google rejected the local redirect (redirect_uri_mismatch): the OAuth client must be of type "Desktop app" (not Web application). Create a Desktop app client at ${PERSONAL_MODE_URL} and update clientId and the secret.`
  if (/invalid_grant/i.test(text)) return "The sign-in expired or was revoked (invalid_grant): sign in again (google_signin)."
  if (/timeout/i.test(text)) return description ?? "The sign-in was not finished in time."
  return `Google sign-in failed: ${(description ?? code ?? "unknown error").split("\n")[0]!.slice(0, 300)}`
}

/** Explains a Google API error, especially an API that is not enabled for the client's project. */
export function explainApiError(status: number, data: unknown, api: Api): string | undefined {
  const error = (data as { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { "@type"?: string; reason?: string; metadata?: Record<string, string> }[] } } | undefined)?.error
  if (!error) return undefined
  const info = error.details?.find(detail => detail["@type"]?.endsWith("google.rpc.ErrorInfo"))
  const disabled = info?.reason === "SERVICE_DISABLED" || error.errors?.some(item => item.reason === "accessNotConfigured") || /has not been used in project|it is disabled/i.test(error.message ?? "")
  if (disabled) {
    const service = info?.metadata?.service ?? /(\w+\.googleapis\.com)/.exec(error.message ?? "")?.[1] ?? APIS[api].service
    const title = info?.metadata?.serviceTitle ?? Object.values(APIS).find(item => item.service === service)?.title ?? service
    const project = (info?.metadata?.consumer ?? "").replace(/^projects\//, "") || /project (\d+)/.exec(error.message ?? "")?.[1]
    return `The ${title} is not enabled in the Google Cloud project of your OAuth client${project ? ` (${project})` : ""}. Enable it at ${API_LIBRARY_URL}/${service}${project ? `?project=${project}` : ""}, wait a minute, then retry.`
  }
  if (status === 403 && (info?.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || error.errors?.some(item => item.reason === "insufficientPermissions"))) return "The sign-in does not include the scope this request needs (e.g. a read-only preset). Change the account's preset and sign in again."
  return undefined
}

// ------------------------------------------------------------------ which API a path belongs to

export interface Target { readonly api: Api; readonly path: string }

/**
 * Resolves a path (optionally with ?query) to its API and its full path on that API's host. Accepts paths that already
 * carry the prefix (/drive/v3/…, /upload/drive/v3/…, /v1/documents…, /v4/spreadsheets…, /v1/presentations…), full
 * https URLs on the four hosts, or a bare path with `api` (files?q=… with drive, documents/ID with docs, …).
 */
export function resolveApi(input: string, api?: Api): Target {
  let path = input.trim()
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path)
    const host = Object.entries(APIS).filter(([, value]) => value.host === url.hostname.toLowerCase())
    if (!host.length) throw new Error(`Only Google Drive, Docs, Sheets and Slides API URLs are allowed (${Object.values(APIS).map(value => value.host).join(", ")})`)
    path = `${url.pathname}${url.search}`
    const found = detect(path)
    if (!found || APIS[found].host !== url.hostname.toLowerCase()) throw new Error(`${url.hostname} does not serve ${url.pathname}`)
    return { api: found, path }
  }
  if (!path.startsWith("/")) path = `/${path}`
  const found = detect(path)
  if (found) {
    if (api && api !== found) throw new Error(`${path.split("?")[0]} is a ${found} path, not ${api}`)
    return { api: found, path }
  }
  if (!api) throw new Error(`Cannot tell which API ${path.split("?")[0]} belongs to: start it with /drive/v3, /upload/drive/v3, /v1/documents, /v4/spreadsheets or /v1/presentations, or pass api=drive|docs|sheets|slides`)
  const resolved = `${APIS[api].prefix}${path}`
  if (detect(resolved) !== api) throw new Error(`${path.split("?")[0]} is not a ${api} path`)
  return { api, path: resolved }
}

function detect(path: string): Api | undefined {
  const p = path.split("?")[0]!
  if (/^\/(upload\/)?drive\/v3(\/|$)/.test(p)) return "drive"
  if (/^\/v1\/documents(\/|:|$)/.test(p)) return "docs"
  if (/^\/v4\/spreadsheets(\/|:|$)/.test(p)) return "sheets"
  if (/^\/v1\/presentations(\/|:|$)/.test(p)) return "slides"
  return undefined
}

// ------------------------------------------------------------------ what a request does

/** The permission kind a single API request needs, from its method and path (and for a few cases the query). */
export function classifyRequest(method: string, target: Target): Kind {
  const m = method.toUpperCase()
  const [rawPath, query = ""] = target.path.split("?")
  const path = (() => { try { return decodeURIComponent(rawPath!) } catch { return rawPath! } })().replace(/\/+$/, "")
  const params = new URLSearchParams(query)
  if (target.api === "drive") {
    const p = path.replace(/^\/(upload\/)?drive\/v3/, "")
    if (/^\/files\/[^/]+\/permissions(\/|$)/.test(p) || /^\/drives\/[^/]+\/permissions(\/|$)/.test(p)) return m === "GET" ? "read" : "share"
    if (/\/accessproposals\/[^/]+:resolve$/i.test(p)) return "share"
    if (params.get("transferOwnership") === "true") return "share"
    if (m === "GET" || m === "HEAD") return "read"
    if (m === "POST" && /^\/files\/[^/]+\/download$/.test(p)) return "read"
    if (m === "DELETE") return "delete"
    return "write"
  }
  if (m === "GET" || m === "HEAD") return "read"
  if (m === "DELETE") return "delete"
  if (target.api === "sheets" && m === "POST" && /(:getByDataFilter|\/values:batchGetByDataFilter|\/developerMetadata:search)$/.test(path)) return "read"
  return "write"
}

const kindOrder: Kind[] = ["read", "write", "share", "delete"]
export const sortKinds = (kinds: Iterable<Kind>): Kind[] => [...new Set(kinds)].sort((a, b) => kindOrder.indexOf(a) - kindOrder.indexOf(b))

// ------------------------------------------------------------------ Google-native file types

export const NATIVE = {
  "application/vnd.google-apps.document": { name: "document", default: "docx", formats: ["docx", "odt", "rtf", "pdf", "txt", "html", "zip", "epub", "md"] },
  "application/vnd.google-apps.spreadsheet": { name: "spreadsheet", default: "xlsx", formats: ["xlsx", "ods", "pdf", "zip", "csv", "tsv"] },
  "application/vnd.google-apps.presentation": { name: "presentation", default: "pptx", formats: ["pptx", "odp", "pdf", "txt"] },
  "application/vnd.google-apps.drawing": { name: "drawing", default: "png", formats: ["pdf", "jpg", "png", "svg"] },
  "application/vnd.google-apps.script": { name: "Apps Script project", default: "json", formats: ["json"] },
} as const

/** Export MIME types by file extension (Drive export formats table). */
export const EXPORT_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  pdf: "application/pdf",
  txt: "text/plain",
  html: "text/html",
  zip: "application/zip",
  epub: "application/epub+zip",
  md: "text/markdown",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  json: "application/vnd.google-apps.script+json",
}

/** Picks the export MIME type and file extension for a Google-native file. `format` is an extension or a MIME type. */
export function exportFormat(nativeType: string, format?: string): { mimeType: string; extension: string } {
  const native = NATIVE[nativeType as keyof typeof NATIVE]
  if (!native) throw new Error(`${nativeType} cannot be exported`)
  const wanted = (format ?? native.default).toLowerCase().replace(/^\./, "").replace(/^jpeg$/, "jpg").replace(/^markdown$/, "md")
  const byMime = Object.entries(EXPORT_TYPES).find(([, mime]) => mime === wanted)
  const extension = byMime ? byMime[0] : wanted
  if (!(native.formats as readonly string[]).includes(extension)) throw new Error(`A Google ${native.name} exports as ${native.formats.join(", ")}; not ${format}`)
  return { mimeType: EXPORT_TYPES[extension]!, extension }
}

/** Upload conversion targets. */
export const CONVERT = { document: "application/vnd.google-apps.document", spreadsheet: "application/vnd.google-apps.spreadsheet", presentation: "application/vnd.google-apps.presentation" } as const

const LOCAL_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXPORT_TYPES).filter(([extension]) => extension !== "json")),
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", htm: "text/html", markdown: "text/markdown",
  json: "application/json", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg", xml: "application/xml",
}
/** A content type for a local file name; application/octet-stream when unknown. */
export function contentTypeOf(name: string): string {
  return LOCAL_TYPES[/\.([^./]+)$/.exec(name.toLowerCase())?.[1] ?? ""] ?? "application/octet-stream"
}

// ------------------------------------------------------------------ rclone in the shell

/** The rclone remote this plugin defines (through environment variables, nothing on disk). */
export const RCLONE_REMOTE = "gdrive"

export interface RclonePlan {
  /** Whether the command uses the `gdrive:` remote with rclone. */
  readonly uses: boolean
  /** Permissions needed, strongest last. */
  readonly kinds: readonly Kind[]
  /** Runs rclone's own interactive setup/login for the remote (which would open a browser and store a token). */
  readonly login: boolean
}

const segments = (command: string) => command.split(/\|\||&&|[|;\n]/).map(part => part.trim()).filter(Boolean)
const words = (segment: string) => [...segment.replace(/^(\w+=\S*\s+)+/, "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]!)
const unquote = (word: string) => word.replace(/^['"]|['"]$/g, "")
const READ_SUBCOMMANDS = new Set(["ls", "lsd", "lsl", "lsf", "lsjson", "tree", "cat", "size", "about", "check", "cryptcheck", "checksum", "hashsum", "md5sum", "sha1sum", "ncdu", "listremotes", "version", "help", "config", "obscure", "test", "gitannex"])
const TRANSFER_SUBCOMMANDS = new Set(["copy", "copyto", "sync", "move", "moveto", "bisync", "check", "cryptcheck"])
const DELETE_SUBCOMMANDS = new Set(["delete", "deletefile", "purge", "rmdirs", "cleanup"])

/** Where `rclone` starts in a segment's words: run directly, by path, or through a launcher (pixi exec --spec rclone rclone …). */
function rcloneAt(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i]!.split("/").pop() ?? "") !== "rclone") continue
    if (i > 0 && /^(--spec|-s|--with|-w|--package|-p)$/.test(argv[i - 1]!)) continue
    return i
  }
  return -1
}

/**
 * Which rclone commands get the `gdrive:` remote and which permissions they need. Commands that don't name
 * `gdrive:` are left exactly as they are. Deletes in Drive go to the trash by default (write); deletes that skip
 * the trash (`--drive-use-trash=false`), emptying the trash (`cleanup`) and the bulk delete commands count as
 * delete; `rclone link` creates a public link (share).
 */
export function planRclone(command: string, remote = RCLONE_REMOTE): RclonePlan {
  const needed = new Set<Kind>()
  let login = false
  const ours = (arg: string) => unquote(arg).startsWith(`${remote}:`)
  const noTrash = /--drive-use-trash(=|\s+)(false|0)\b|RCLONE_DRIVE_USE_TRASH=(false|0)\b/i.test(command)
  for (const segment of segments(command)) {
    const argv = words(segment)
    const at = rcloneAt(argv)
    if (at < 0) continue
    const args = argv.slice(at + 1)
    const positional = args.filter(arg => !arg.startsWith("-"))
    const sub = positional[0] ?? ""
    const targets = positional.slice(1)
    const mentions = targets.some(ours) || (sub === "config" && targets.some(arg => unquote(arg).replace(/:$/, "") === remote))
    if (!mentions) continue
    if (sub === "config" || sub === "authorize") { login = /^(reconnect|create|update|edit|userinfo)$/.test(targets[0] ?? "") || sub === "authorize"; needed.add("read"); continue }
    if (sub === "link") { needed.add("share"); continue }
    if (DELETE_SUBCOMMANDS.has(sub)) { needed.add("delete"); continue }
    if (TRANSFER_SUBCOMMANDS.has(sub)) {
      const destination = targets[targets.length - 1] ?? ""
      const source = targets.slice(0, -1)
      if (ours(destination) && !["check", "cryptcheck"].includes(sub)) needed.add(noTrash && /^(sync|move|moveto|bisync)$/.test(sub) ? "delete" : "write")
      if (source.some(ours)) needed.add(/^(move|moveto|bisync)$/.test(sub) ? (noTrash ? "delete" : "write") : "read")
      if (!needed.size) needed.add("read")
      continue
    }
    if (READ_SUBCOMMANDS.has(sub)) { needed.add("read"); continue }
    if (sub === "serve") { needed.add(/--read-only\b/.test(segment) || /^(dlna|docker)$/.test(targets[0] ?? "") ? "read" : "write"); continue }
    if (sub === "backend") { needed.add(/^(features|help)$/.test(targets[0] ?? "") ? "read" : "write"); continue }
    if (sub === "rmdir" && noTrash) { needed.add("delete"); continue }
    // mount, nfsmount, mkdir, touch, rcat, copyurl, dedupe, settier, rmdir, rc, … change things.
    needed.add(sub === "dedupe" && noTrash ? "delete" : "write")
  }
  return { uses: needed.size > 0, kinds: sortKinds(needed), login }
}

/** rclone's environment for the remote: type drive, the user's OAuth client and the current token. */
export function rcloneEnv(remote: string, clientId: string, clientSecret: string, accessToken: string, refreshToken: string | undefined, expiresAt: number, readOnly: boolean): Record<string, string> {
  const prefix = `RCLONE_CONFIG_${remote.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
  return {
    [`${prefix}_TYPE`]: "drive",
    [`${prefix}_CLIENT_ID`]: clientId,
    [`${prefix}_CLIENT_SECRET`]: clientSecret,
    [`${prefix}_SCOPE`]: readOnly ? "drive.readonly" : "drive",
    [`${prefix}_TOKEN`]: JSON.stringify({ access_token: accessToken, token_type: "Bearer", ...(refreshToken && { refresh_token: refreshToken }), expiry: new Date(expiresAt).toISOString() }),
  }
}

/** Google tokens and client secrets as rclone may print them (e.g. `rclone config show` or -vv). */
export const GOOGLE_SECRET_PATTERNS: readonly RegExp[] = [/ya29\.[A-Za-z0-9_\-.]{20,}/g, /1\/\/[A-Za-z0-9_\-]{20,}/g, /GOCSPX-[A-Za-z0-9_\-]{10,}/g]
