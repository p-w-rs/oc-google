// Test helper: a fake Google OAuth server (authorize with PKCE and a 127.0.0.1 loopback redirect, token, refresh, revoke,
// Personal-mode client_user_mismatch) and fake Drive v3 / Docs / Sheets / Slides APIs on one base URL: about, files
// list/get/create/update/delete, alt=media, export, multipart and resumable upload, permissions, emptyTrash,
// documents.get/batchUpdate, values get/update, presentations batchUpdate, and an API that is not enabled.
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export const CLIENT_ID = "123456789012-fakeclient0123456789abcdef.apps.googleusercontent.com"
export const CLIENT_SECRET = "GOCSPX-fakeSecretValue_0123456789"

export interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; content: Buffer; trashed?: boolean }

export interface FakeGoogle {
  readonly authUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
  readonly apiBase: string
  /** The browser: follow the authorize URL to the loopback redirect. `as` signs in as another Google account. */
  approve(authorizeUrl: string, options?: { as?: string; deny?: boolean }): Promise<void>
  readonly files: Map<string, FakeFile>
  readonly permissions: { fileId: string; body: unknown }[]
  readonly docEdits: { documentId: string; requests: unknown[] }[]
  readonly revoked: string[]
  readonly requests: { method: string; path: string }[]
  /** Last authorize query (to check PKCE, access_type, prompt, login_hint). */
  lastAuthorize?: URLSearchParams
  /** APIs (docs, sheets, slides) that answer 403 SERVICE_DISABLED. */
  readonly disabled: Set<string>
  /** Chunk sizes received by resumable uploads. */
  readonly chunks: number[]
  /** Restores the sample files and sheet values. */
  reset(): void
  expireTokens(): void
  stop(): Promise<void>
}

export async function startFakeGoogle(options: { owner?: string } = {}): Promise<FakeGoogle> {
  const owner = options.owner ?? "pat@example.com"
  const codes = new Map<string, { challenge: string; redirect: string; scope: string }>()
  const access = new Map<string, number>()
  const refresh = new Map<string, string>()
  const revoked: string[] = []
  const requests: FakeGoogle["requests"] = []
  const permissions: FakeGoogle["permissions"] = []
  const docEdits: FakeGoogle["docEdits"] = []
  const disabled = new Set<string>()
  const chunks: number[] = []
  const seed = (): [string, FakeFile][] => [
    ["f-report", { id: "f-report", name: "Q3 report.pdf", mimeType: "application/pdf", parents: ["root"], content: Buffer.from("%PDF-fake Q3\n") }],
    ["f-doc", { id: "f-doc", name: "Plan", mimeType: "application/vnd.google-apps.document", parents: ["root"], content: Buffer.from("# Plan\n\nShip it.\n") }],
    ["f-sheet", { id: "f-sheet", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["root"], content: Buffer.from("item,cost\nrobot,100\n") }],
    ["f-folder", { id: "f-folder", name: "Projects", mimeType: "application/vnd.google-apps.folder", parents: ["root"], content: Buffer.alloc(0) }],
  ]
  const files = new Map<string, FakeFile>(seed())
  const values = new Map<string, unknown[][]>()
  const sessions = new Map<string, { size: number; parts: Buffer[]; metadata: Record<string, unknown>; fileId?: string }>()
  let base = ""
  let next = 0
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json; charset=UTF-8", ...headers }); res.end(JSON.stringify(body)) }
  const read = async (req: IncomingMessage) => { const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk as Buffer); return Buffer.concat(parts) }
  const grant = (scope: string, withRefresh = true) => {
    const token = `ya29.${randomBytes(20).toString("base64url")}`; access.set(token, Date.now() + 3600_000)
    const r = `1//0${randomBytes(30).toString("base64url")}`
    if (withRefresh) refresh.set(r, scope)
    return { access_token: token, expires_in: 3599, token_type: "Bearer", scope, ...(withRefresh && { refresh_token: r }), id_token: "eyJhbGciOi.fake.sig" }
  }
  const gerror = (status: number, message: string, reason: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: { code: status, message, errors: [{ message, domain: "global", reason }], ...extra } } })
  const meta = (file: FakeFile) => ({ kind: "drive#file", id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents, ...(!file.mimeType.startsWith("application/vnd.google-apps.") && { size: String(file.content.length) }), webViewLink: `https://drive.google.com/file/d/${file.id}/view` })
  const create = (metadata: Record<string, unknown>, content: Buffer, existing?: string): FakeFile => {
    const file = existing ? files.get(existing)! : { id: `f-${++next}`, name: String(metadata.name ?? "Untitled"), mimeType: "application/octet-stream", parents: (metadata.parents as string[]) ?? ["root"], content }
    if (metadata.name) file.name = String(metadata.name)
    if (metadata.mimeType) file.mimeType = String(metadata.mimeType)
    else if (!existing) file.mimeType = "application/octet-stream"
    file.content = content
    files.set(file.id, file)
    return file
  }

  const api = async (req: IncomingMessage, method: string, url: URL, raw: Buffer): Promise<{ status: number; body?: unknown; raw?: Buffer; type?: string; headers?: Record<string, string> }> => {
    const p = decodeURIComponent(url.pathname)
    requests.push({ method, path: `${p}${decodeURIComponent(url.search)}` })
    const json = () => raw.length ? JSON.parse(raw.toString()) : undefined
    for (const name of disabled) {
      const prefix = { docs: "/v1/documents", sheets: "/v4/spreadsheets", slides: "/v1/presentations", drive: "/drive/v3" }[name]
      if (prefix && p.startsWith(prefix)) {
        const service = `${name}.googleapis.com`
        return { status: 403, body: { error: { code: 403, message: `Google ${name} API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${service}/overview?project=123456789012 then retry.`, status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service, consumer: "projects/123456789012", serviceTitle: `Google ${name[0]!.toUpperCase()}${name.slice(1)} API` } }] } } }
      }
    }
    if (p === "/drive/v3/about") return { status: 200, body: { user: { displayName: "Pat Lee", emailAddress: owner }, storageQuota: { limit: "16106127360", usage: "2147483648" } } }
    if (p === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? ""
      const inParent = /'([^']+)' in parents/.exec(q)?.[1]
      const nameHas = /name contains '([^']+)'/.exec(q)?.[1]
      const list = [...files.values()].filter(file => !file.trashed && (!inParent || file.parents.includes(inParent)) && (!nameHas || file.name.toLowerCase().includes(nameHas.toLowerCase())))
      return { status: 200, body: { files: list.map(meta) } }
    }
    if (p === "/drive/v3/files" && method === "POST") { const file = create(json() ?? {}, Buffer.alloc(0)); return { status: 200, body: meta(file) } }
    if (p === "/drive/v3/files/trash" && method === "DELETE") { for (const [id, file] of files) if (file.trashed) files.delete(id); return { status: 204 } }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)
    if (one) {
      const file = files.get(one[1]!)
      if (!file) return gerror(404, `File not found: ${one[1]}.`, "notFound")
      if (method === "GET") {
        if (url.searchParams.get("alt") === "media") {
          if (file.mimeType.startsWith("application/vnd.google-apps.")) return gerror(403, "Only files with binary content can be downloaded. Use Export with Docs Editors files.", "fileNotDownloadable")
          return { status: 200, raw: file.content, type: file.mimeType }
        }
        return { status: 200, body: meta(file) }
      }
      if (method === "PATCH") {
        const body = json() ?? {}
        if (body.name) file.name = body.name
        if (body.trashed !== undefined) file.trashed = body.trashed
        const add = url.searchParams.get("addParents"), remove = url.searchParams.get("removeParents")
        if (add || remove) file.parents = [...file.parents.filter(parent => parent !== remove), ...(add ? [add] : [])]
        return { status: 200, body: meta(file) }
      }
      if (method === "DELETE") { files.delete(file.id); return { status: 204 } }
    }
    const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p)
    if (exp && method === "GET") {
      const file = files.get(exp[1]!)
      if (!file) return gerror(404, "File not found.", "notFound")
      const type = url.searchParams.get("mimeType") ?? ""
      if (!file.mimeType.startsWith("application/vnd.google-apps.")) return gerror(403, "Export only supports Docs Editors files.", "fileNotExportable")
      if (file.name === "Huge") return gerror(403, "This file is too large to be exported.", "exportSizeLimitExceeded")
      return { status: 200, raw: type === "text/markdown" || type === "text/csv" ? file.content : Buffer.concat([Buffer.from(`[${type}]\n`), file.content]), type }
    }
    const perms = /^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(p)
    if (perms) {
      if (method === "GET") return { status: 200, body: { permissions: [{ id: "owner", type: "user", role: "owner", emailAddress: owner }] } }
      permissions.push({ fileId: perms[1]!, body: json() })
      return { status: 200, body: { kind: "drive#permission", id: `perm-${permissions.length}`, ...(json() ?? {}) } }
    }
    const doc = /^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/.exec(p)
    if (doc) {
      if (method === "GET" && !doc[2]) return { status: 200, body: { documentId: doc[1], title: "Plan", body: { content: [{ startIndex: 1, endIndex: 7, paragraph: { elements: [{ startIndex: 1, endIndex: 7, textRun: { content: "Plan\n" } }] } }] } } }
      if (method === "POST" && doc[2]) { const body = json(); docEdits.push({ documentId: doc[1]!, requests: body.requests }); return { status: 200, body: { documentId: doc[1], replies: body.requests.map(() => ({})), writeControl: { requiredRevisionId: "rev-2" } } } }
    }
    const vals = /^\/v4\/spreadsheets\/([^/]+)\/values\/(.+?)(:append)?$/.exec(p)
    if (vals) {
      if (method === "GET") return { status: 200, body: { range: vals[2], majorDimension: "ROWS", values: values.get(vals[1]!) ?? [] } }
      if (!url.searchParams.get("valueInputOption")) return gerror(400, "'valueInputOption' is required but not specified", "badRequest")
      const rows = (json() as { values: unknown[][] }).values
      values.set(vals[1]!, vals[3] ? [...(values.get(vals[1]!) ?? []), ...rows] : rows)
      return { status: 200, body: { spreadsheetId: vals[1], updatedRange: vals[2], updatedRows: rows.length } }
    }
    const pres = /^\/v1\/presentations\/([^/:]+):batchUpdate$/.exec(p)
    if (pres && method === "POST") return { status: 200, body: { presentationId: pres[1], replies: [{ createSlide: { objectId: "slide_1" } }] } }
    return gerror(404, `fake google: ${method} ${p}`, "notFound")
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    const path = url.pathname
    if (path === "/o/oauth2/v2/auth") {
      const p = url.searchParams
      if (p.get("client_id") !== CLIENT_ID) return send(res, 401, { error: "invalid_client", error_description: "The OAuth client was not found." })
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(p.get("redirect_uri") ?? "")) return send(res, 400, { error: "redirect_uri_mismatch" })
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || p.get("response_type") !== "code") return send(res, 400, { error: "invalid_request" })
      const code = `4/0${randomBytes(12).toString("base64url")}`
      codes.set(code, { challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, scope: p.get("scope")! })
      res.writeHead(302, { location: `${p.get("redirect_uri")}/?state=${encodeURIComponent(p.get("state") ?? "")}&code=${encodeURIComponent(code)}&scope=${encodeURIComponent(p.get("scope")!)}` }); res.end(); return
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams((await read(req)).toString())
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return send(res, 401, { error: "invalid_client", error_description: "Unauthorized" })
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code") ?? "")
        if (!entry || entry.redirect !== form.get("redirect_uri") || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) return send(res, 400, { error: "invalid_grant", error_description: "Bad Request" })
        codes.delete(form.get("code")!)
        return send(res, 200, grant(entry.scope))
      }
      if (form.get("grant_type") === "refresh_token") {
        const scope = refresh.get(form.get("refresh_token") ?? "")
        if (!scope) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })
        return send(res, 200, grant(scope, false))
      }
      return send(res, 400, { error: "unsupported_grant_type" })
    }
    if (path === "/revoke" && req.method === "POST") {
      const value = new URLSearchParams((await read(req)).toString()).get("token") ?? ""
      revoked.push(value); refresh.delete(value)
      return send(res, 200, {})
    }
    if (path.startsWith("/upload/drive/v3/files")) {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
      const sessionId = url.searchParams.get("upload_id")
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (!session) return send(res, 404, { error: { code: 404, message: "upload session not found" } })
        const chunk = await read(req)
        const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(String(req.headers["content-range"]))!
        chunks.push(chunk.length)
        session.parts.push(chunk)
        const end = Number(range[2])
        if (end + 1 < session.size) { res.writeHead(308, { range: `bytes=0-${end}` }); res.end(); return }
        const file = create(session.metadata, Buffer.concat(session.parts), session.fileId)
        sessions.delete(sessionId)
        return send(res, 200, meta(file))
      }
      if (!(access.get(token)! > Date.now())) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } })
      requests.push({ method: req.method!, path: `${path}${url.search}` })
      const existing = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1]
      const raw = await read(req)
      if (url.searchParams.get("uploadType") === "multipart") {
        const boundary = /boundary=([^;]+)/.exec(String(req.headers["content-type"]))![1]!
        const parts = raw.toString("latin1").split(`--${boundary}`).slice(1, -1).map(part => part.replace(/^\r\n/, "").replace(/\r\n$/, ""))
        const [metaPart, mediaPart] = parts.map(part => part.slice(part.indexOf("\r\n\r\n") + 4))
        return send(res, 200, meta(create(JSON.parse(metaPart!), Buffer.from(mediaPart!, "latin1"), existing)))
      }
      if (url.searchParams.get("uploadType") === "resumable") {
        const id = randomBytes(8).toString("hex")
        sessions.set(id, { size: Number(req.headers["x-upload-content-length"]), parts: [], metadata: raw.length ? JSON.parse(raw.toString()) : {}, ...(existing && { fileId: existing }) })
        res.writeHead(200, { location: `${base}/upload/drive/v3/files${existing ? `/${existing}` : ""}?uploadType=resumable&upload_id=${id}`, "content-length": "0" }); res.end(); return
      }
      return send(res, 400, { error: { code: 400, message: "bad uploadType" } })
    }
    if (/^\/(drive\/v3|v1\/documents|v4\/spreadsheets|v1\/presentations)(\/|:|$)/.test(path)) {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
      if (!(access.get(token)! > Date.now())) return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } })
      const result = await api(req, req.method!, url, await read(req))
      if (result.raw) { res.writeHead(result.status, { "content-type": result.type ?? "application/octet-stream" }); res.end(result.raw); return }
      if (result.body === undefined) { res.writeHead(result.status); res.end(); return }
      return send(res, result.status, result.body, result.headers)
    }
    send(res, 404, { error: { code: 404, message: "not found" } })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const fake: FakeGoogle = {
    authUrl: `${base}/o/oauth2/v2/auth`, tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke`, apiBase: base,
    files, permissions, docEdits, revoked, requests, disabled, chunks,
    async approve(authorizeUrl, opts = {}) {
      fake.lastAuthorize = new URL(authorizeUrl).searchParams
      const redirect = await fetch(authorizeUrl, { redirect: "manual" })
      const location = redirect.headers.get("location")
      if (!location) throw new Error(`authorize failed: ${redirect.status} ${await redirect.text()}`)
      const back = new URL(location)
      if (opts.deny) { back.search = `?state=${back.searchParams.get("state")}&error=access_denied` }
      else if (opts.as && opts.as !== owner) { back.search = `?state=${back.searchParams.get("state")}&error=client_user_mismatch` }
      await fetch(back)
    },
    reset() { files.clear(); for (const [id, file] of seed()) files.set(id, file); values.clear() },
    expireTokens() { for (const token of access.keys()) access.set(token, 0) },
    async stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
  return fake
}
