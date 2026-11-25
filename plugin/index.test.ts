import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, SecretRequests, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { CLIENT_ID, CLIENT_SECRET, startFakeGoogle, type FakeGoogle } from "./testgoogle.js"

const dirs: string[] = []
let fake: FakeGoogle
before(async () => { fake = await startFakeGoogle() })
after(async () => { await fake.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  fake.reset()
  const dir = await mkdtemp(join(tmpdir(), "ocg-"))
  dirs.push(dir)
  const hooks = { evaluate: [] as any[], after: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string; content: string }[] = []
  const prompts: { action: string; metadata?: Record<string, unknown> }[] = []
  let rpc: any
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const ctx = {
    options: { dataDirectory: dir, authUrl: fake.authUrl, tokenUrl: fake.tokenUrl, revokeUrl: fake.revokeUrl, apiBase: fake.apiBase, ...options },
    session: { get: async () => ({ parentID: undefined, location: { directory: dir } }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, metadata: input.metadata }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (_: string, callback: any) => registration(hooks.after, callback),
    },
    skill: { transform: async (callback: any) => { callback({ add: (skill: any) => skills.push(skill) }); return { dispose: async () => { skills.length = 0 } } } },
    event: { subscribe: () => (async function* () {})() },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", hidden: false }] }) },
    rpc: { register: async (_: unknown, handlers: any) => { rpc = handlers; return { dispose: async () => { rpc = undefined } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  /** Calls a tool the way OpenCode does, including the redaction hook; returns parsed JSON or text. */
  const raw = async (name: string, input: unknown, agent = "build") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = { sessionID: "s", agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} }
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    for (const hook of hooks.after) await hook(event)
    if (event.status === "error") throw event.error
    return event.result.content as string
  }
  const call = async (name: string, input: unknown, agent = "build") => { const text = await raw(name, input, agent); try { return JSON.parse(text) } catch { return text } }
  /** The user enters the secret in the GUI. */
  const enterSecret = (id = "personal") => rpc.setSecret({ id, secret: CLIENT_SECRET })
  const signIn = async (id = "personal", input: Record<string, unknown> = {}, approve: { as?: string; deny?: boolean } = {}) => {
    await call("google_account_upsert", { id, clientId: CLIENT_ID, email: "pat@example.com", ...input })
    await enterSecret(id)
    const started = await call("google_signin", { account: id })
    await fake.approve(/(http\S+\/o\/oauth2\/v2\/auth\?\S+?)(\s|$)/.exec(started.tellUser)![1]!, approve)
    for (let i = 0; i < 100; i++) { const list = await call("google_list", {}); const account = list.accounts.find((a: { id: string }) => a.id === id); if (account.signedInAs || account.signInFailed) return account; await new Promise(r => setTimeout(r, 30)) }
    throw new Error("sign-in did not settle")
  }
  return { dir, tools, skills, prompts, raw, call, signIn, enterSecret, cleanup, rpc: () => rpc, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }), requests: () => SecretRequests.open(dir) }
}

test("identity, tools, skill, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 9)
  assert.equal(h.skills[0]!.id, "google")
  assert.match(h.skills[0]!.content, /write backwards/i)
  assert.match(h.tools.get("google_list")!.description, /No Google accounts are configured yet/)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  const broken = await host("approve", { apiBase: "ftp://x" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ tokenUrl: 1 }), /string/)
})

test("setup: client ID, secret requested and entered outside the chat, browser sign-in with PKCE on 127.0.0.1", async () => {
  const h = await host()
  const created = await h.call("google_account_upsert", { id: "personal", email: "pat@example.com" })
  assert.match(created.next, /Desktop app OAuth client/)
  await assert.rejects(h.call("google_account_upsert", { id: "personal", clientSecret: CLIENT_SECRET }), /additional|Unknown|not allowed|clientSecret/)
  await assert.rejects(h.call("google_request_secret", { account: "personal" }), /Set the client ID first/)
  const withClient = await h.call("google_account_upsert", { id: "personal", clientId: CLIENT_ID })
  assert.equal(withClient.clientSecret, "unset")
  assert.match(withClient.next, /google_request_secret/)
  await assert.rejects(h.call("google_signin", { account: "personal" }), /client secret for personal is not entered yet/)

  const asked = await h.call("google_request_secret", { account: "personal", purpose: "to sign in to Drive" })
  assert.equal(asked.status, "unset")
  assert.match(asked.tellUser, /Settings → Google.*pixi run secret-set personal/)
  const state = await h.rpc().state({})
  assert.deepEqual(state.requests.map((r: { entity: string; label: string; purpose: string }) => [r.entity, r.label, r.purpose]), [["personal", "client secret for personal", "to sign in to Drive"]])
  assert.match(state.setup.join(" "), /auth\/overview\/personal.*Desktop app/)
  assert.equal(state.links.apis.length, 4)
  await assert.rejects(h.rpc().setSecret({ id: "personal", secret: "short" }), /does not look like/)
  await h.enterSecret()
  assert.deepEqual((await h.rpc().state({})).requests, [], "the request is cleared once the secret is set")
  assert.equal((await h.call("google_list", {})).accounts[0].clientSecret, "set")

  const started = await h.call("google_signin", { account: "personal" })
  assert.equal(started.status, "waiting")
  await fake.approve(/(http\S+\/o\/oauth2\/v2\/auth\?\S+?)(\s|$)/.exec(started.tellUser)![1]!)
  const query = fake.lastAuthorize!
  assert.equal(query.get("code_challenge_method"), "S256")
  assert.equal(query.get("access_type"), "offline")
  assert.equal(query.get("prompt"), "consent")
  assert.equal(query.get("include_granted_scopes"), null)
  assert.equal(query.get("login_hint"), "pat@example.com")
  assert.match(query.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.match(query.get("scope")!, /auth\/drive .*auth\/documents/)
  let account: any
  for (let i = 0; i < 100 && !account?.signedInAs; i++) { account = (await h.call("google_list", {})).accounts[0]; await new Promise(r => setTimeout(r, 30)) }
  assert.equal(account.signedInAs, "Pat Lee <pat@example.com>")
  assert.ok(account.grantedScopes.includes("https://www.googleapis.com/auth/drive"))
  assert.deepEqual(account.youMay, { read: "allow", write: "allow", share: "ask", delete: "ask" })
  await new Promise(r => setTimeout(r, 30))
  assert.match(h.tools.get("google_list")!.description, /personal: Pat Lee <pat@example\.com>; 2\.0 GB of 15 GB used/)
})

test("sign-in errors: Personal-mode creator mismatch and access denied are explained", async () => {
  const h = await host()
  const mismatch = await h.signIn("personal", {}, { as: "other@example.com" })
  assert.match(mismatch.signInFailed, /only the Google account that created it can sign in/)
  const denied = await h.signIn("personal", {}, { deny: true })
  assert.match(denied.signInFailed, /declined/)
})

test("API calls: reads and edits run; sharing and permanent deletes ask; trash is an edit; batchUpdate edits a Doc", async () => {
  const h = await host()
  await h.signIn()
  const list = await h.call("google_api", { api: "drive", path: "files", query: { q: "name contains 'plan' and trashed = false", fields: "files(id,name,mimeType)", pageSize: 10 } })
  assert.deepEqual(list.files.map((f: { id: string }) => f.id), ["f-doc"])
  assert.ok(fake.requests.some(r => r.path.includes("q=name contains 'plan' and trashed = false")), "query passed through")
  await h.call("google_api", { path: "/drive/v3/files/f-report", method: "PATCH", query: { addParents: "f-folder", removeParents: "root" } })
  assert.deepEqual(fake.files.get("f-report")!.parents, ["f-folder"])
  await h.call("google_api", { api: "drive", path: "files/f-report", method: "PATCH", body: { trashed: true } })
  const edit = await h.call("google_api", { api: "docs", method: "POST", path: "documents/f-doc:batchUpdate", body: { requests: [{ replaceAllText: { containsText: { text: "Ship it", matchCase: true }, replaceText: "Shipped" } }] } })
  assert.equal(edit.writeControl.requiredRevisionId, "rev-2")
  assert.equal(fake.docEdits.at(-1)!.documentId, "f-doc")
  const doc = await h.call("google_api", { path: "/v1/documents/f-doc" })
  assert.equal(doc.title, "Plan")
  await h.call("google_api", { api: "sheets", method: "PUT", path: "spreadsheets/f-sheet/values/Sheet1!A1:B2", query: { valueInputOption: "USER_ENTERED" }, body: { values: [["a", "b"], ["c", "=1+2"]] } })
  assert.deepEqual((await h.call("google_api", { api: "sheets", path: "spreadsheets/f-sheet/values/Sheet1!A1:B2" })).values, [["a", "b"], ["c", "=1+2"]])
  await h.call("google_api", { api: "slides", method: "POST", path: "presentations/p1:batchUpdate", body: { requests: [{ createSlide: { slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" } } }] } })
  assert.deepEqual(h.prompts, [], "reading, editing, moving and trashing do not ask")

  await h.call("google_api", { api: "drive", method: "POST", path: "files/f-doc/permissions", query: { sendNotificationEmail: false }, body: { type: "user", role: "reader", emailAddress: "sam@example.com" } })
  await h.call("google_api", { api: "drive", method: "DELETE", path: "files/f-sheet" })
  await h.call("google_api", { api: "drive", method: "DELETE", path: "files/trash" })
  assert.deepEqual((h.prompts as { action: string }[]).map(p => p.action), ["oc-google.share", "oc-google.delete", "oc-google.delete"])
  assert.match(String((h.prompts as { metadata?: Record<string, unknown> }[])[0]!.metadata?.request), /POST drive \/drive\/v3\/files\/f-doc\/permissions\?sendNotificationEmail=false/)
  assert.equal(fake.permissions.at(-1)!.fileId, "f-doc")
  assert.ok(!fake.files.has("f-report") && !fake.files.has("f-sheet"))

  const rejecting = await host("reject")
  await rejecting.signIn()
  const before = fake.permissions.length
  await assert.rejects(rejecting.call("google_api", { api: "drive", method: "POST", path: "files/f-doc/permissions", query: { transferOwnership: true }, body: { type: "user", role: "owner", emailAddress: "sam@example.com" } }), /rejected by user/)
  assert.equal(fake.permissions.length, before, "nothing shared when rejected")
  await (await h.policy()).setCells([{ entity: "personal", row: { agent: "plan" }, capability: "write", effect: "deny" }])
  await assert.rejects(h.call("google_api", { api: "docs", method: "POST", path: "documents/f-doc:batchUpdate", body: { requests: [] } }, "plan"), /Denied by the oc-google permissions table \(write on personal\)/)
  await assert.rejects(h.call("google_api", { path: "https://evil.example/drive/v3/files" }), /Only Google Drive, Docs, Sheets and Slides API URLs/)
  await assert.rejects(h.call("google_api", { path: "files" }), /Cannot tell which API/)
  await assert.rejects(h.call("google_api", { api: "drive", path: "files", headers: { Authorization: "x" } }), /not allowed/)
  await assert.rejects(h.call("google_api", { api: "drive", path: "files/nope" }), /404 notFound: File not found/)
})

test("an API that is not enabled is explained with a link to enable it", async () => {
  const h = await host()
  await h.signIn()
  fake.disabled.add("docs")
  try { await assert.rejects(h.call("google_api", { api: "docs", path: "documents/f-doc" }), /Google Docs API is not enabled.*https:\/\/console\.cloud\.google\.com\/apis\/library\/docs\.googleapis\.com\?project=123456789012/s) }
  finally { fake.disabled.delete("docs") }
})

test("tokens refresh transparently; the refresh token is kept when Google does not send a new one", async () => {
  const h = await host()
  await h.signIn()
  const vault = await h.vault()
  const refresh = await vault.get("personal", "refresh-token")
  const access = await vault.get("personal", "access-token")
  fake.expireTokens()
  assert.equal((await h.call("google_api", { api: "drive", path: "about", query: { fields: "user" } })).user.displayName, "Pat Lee")
  assert.notEqual(await vault.get("personal", "access-token"), access)
  assert.equal(await vault.get("personal", "refresh-token"), refresh)
})

test("downloads: binary as is, Google files exported (default docx, md, csv), into a folder, 10 MB export limit", async () => {
  const h = await host()
  await h.signIn()
  const pdf = await h.call("google_download", { fileId: "f-report", to: "out/" })
  assert.equal(pdf.saved, join(h.dir, "out", "Q3 report.pdf"))
  assert.equal(await readFile(pdf.saved, "utf8"), "%PDF-fake Q3\n")
  const md = await h.call("google_download", { fileId: "f-doc", format: "md", to: "plan.md" })
  assert.equal(md.exportedAs, "text/markdown")
  assert.equal(await readFile(join(h.dir, "plan.md"), "utf8"), "# Plan\n\nShip it.\n")
  const docx = await h.call("google_download", { fileId: "f-doc", to: "out/" })
  assert.equal(docx.saved, join(h.dir, "out", "Plan.docx"))
  assert.match(await readFile(docx.saved, "utf8"), /wordprocessingml/)
  const csv = await h.call("google_download", { fileId: "f-sheet", format: "csv", to: join(h.dir, "budget.csv") })
  assert.equal(csv.bytes, 20)
  const raw = await h.call("google_download", { path: "/drive/v3/files/f-report?alt=media", to: "raw.pdf" })
  assert.equal(raw.bytes, 13)
  await assert.rejects(h.call("google_download", { fileId: "f-folder", to: "x/" }), /is a folder, not a file/)
  await assert.rejects(h.call("google_download", { fileId: "f-report", format: "md", to: "x" }), /regular file/)
  await assert.rejects(h.call("google_download", { fileId: "f-sheet", format: "pptx", to: "x" }), /exports as xlsx/)
  fake.files.set("f-huge", { id: "f-huge", name: "Huge", mimeType: "application/vnd.google-apps.document", parents: ["root"], content: Buffer.alloc(0) })
  await assert.rejects(h.call("google_download", { fileId: "f-huge", format: "pdf", to: "huge.pdf" }), /limited to 10 MB/)
  assert.deepEqual(h.prompts, [])
})

test("uploads: multipart below 5 MB, resumable in 256 KiB-multiple chunks above, convert, replace content", async () => {
  const h = await host()
  await h.signIn()
  await writeFile(join(h.dir, "notes.md"), "# Notes\n\nhello\n")
  const small = await h.call("google_upload", { from: "notes.md", parents: ["f-folder"], convert: "document" })
  const created = fake.files.get(small.uploaded.id)!
  assert.equal(created.name, "notes.md")
  assert.equal(created.mimeType, "application/vnd.google-apps.document")
  assert.deepEqual(created.parents, ["f-folder"])
  assert.equal(created.content.toString(), "# Notes\n\nhello\n")
  assert.ok(fake.requests.some(r => r.path.startsWith("/upload/drive/v3/files?uploadType=multipart")))

  const big = Buffer.alloc(9 * 1024 * 1024 + 123)
  for (let i = 0; i < big.length; i++) big[i] = i % 251
  await writeFile(join(h.dir, "big.bin"), big)
  const large = await h.call("google_upload", { from: "big.bin", name: "Data.bin" })
  const stored = fake.files.get(large.uploaded.id)!
  assert.equal(stored.name, "Data.bin")
  assert.ok(stored.content.equals(big), "resumable upload reassembled")
  assert.ok(fake.chunks.length >= 2 && fake.chunks.slice(0, -1).every(size => size % (256 * 1024) === 0), `chunks ${fake.chunks}`)

  await writeFile(join(h.dir, "v2.md"), "# Notes v2\n")
  const replaced = await h.call("google_upload", { from: "v2.md", fileId: small.uploaded.id })
  assert.equal(replaced.uploaded.id, small.uploaded.id)
  assert.equal(fake.files.get(small.uploaded.id)!.content.toString(), "# Notes v2\n")
  assert.equal(fake.files.get(small.uploaded.id)!.name, "notes.md", "replacing keeps the name")
  fake.chunks.length = 0
  const bigReplace = await h.call("google_upload", { from: "big.bin", fileId: large.uploaded.id })
  assert.equal(bigReplace.uploaded.id, large.uploaded.id)
  assert.ok(fake.chunks.length >= 2)
  await assert.rejects(h.call("google_upload", { from: "v2.md", fileId: "x", parents: ["y"] }), /parents applies to new files/)
  assert.deepEqual(h.prompts, [], "uploads are edits")
})

test("secrets never reach the agent: tokens and the client secret are redacted from any tool output", async () => {
  const h = await host()
  await h.signIn()
  const vault = await h.vault()
  const values = [CLIENT_SECRET, (await vault.get("personal", "access-token"))!, (await vault.get("personal", "refresh-token"))!]
  const outputs = [await h.raw("google_list", {}), await h.raw("google_refresh", {}), await h.raw("google_account_upsert", { id: "personal", label: "Home" })]
  // A file whose content happens to contain the secret is masked too.
  fake.files.set("f-leak", { id: "f-leak", name: "leak", mimeType: "application/vnd.google-apps.document", parents: ["root"], content: Buffer.from(`secret ${CLIENT_SECRET} token ${values[1]}`) })
  outputs.push(await h.raw("google_api", { api: "drive", path: "files/f-leak/export", query: { mimeType: "text/plain" } }))
  for (const output of outputs) for (const value of values) assert.ok(!output.includes(value), "a secret leaked")
  assert.match(outputs.at(-1)!, /\[REDACTED:personal\/client-secret\].*\[REDACTED:personal\/access-token\]/)
  const state = JSON.stringify(await h.rpc().state({}))
  for (const value of values) assert.ok(!state.includes(value), "a secret reached the GUI state")
})

test("account changes: new client ID drops the secret and sign-in; read preset; remove revokes and asks", async () => {
  const h = await host()
  await h.signIn()
  await h.rpc().updateAccount({ id: "personal", preset: "read" })
  let view = (await h.rpc().state({})).accounts[0]
  assert.equal(view.signedIn, false, "changing access requires signing in again")
  assert.equal(view.clientSecret, "set", "the client secret is kept")
  assert.ok(view.requested.includes("https://www.googleapis.com/auth/drive.readonly"))
  await h.call("google_account_upsert", { id: "personal", clientId: "999999999999-otherclient0123.apps.googleusercontent.com" })
  view = (await h.rpc().state({})).accounts[0]
  assert.equal(view.clientSecret, "unset", "a new client needs its own secret")

  const other = await host()
  await other.signIn()
  const refresh = await (await other.vault()).get("personal", "refresh-token")
  await other.call("google_account_remove", { account: "personal" })
  assert.deepEqual(other.prompts.map(p => p.action), ["oc-google.remove"])
  assert.ok(fake.revoked.includes(refresh!), "the grant was revoked at Google")
  assert.equal((await (await other.vault()).list("personal")).length, 0)
  assert.equal((await other.call("google_list", {})).accounts.length, 0)
})

test("GUI admin: create with secret, export and import keep the sign-in, dismiss a request", async () => {
  const h = await host()
  await h.rpc().createAccount({ id: "home", clientId: CLIENT_ID, email: "pat@example.com" })
  await h.call("google_request_secret", { account: "home" })
  const request = (await h.rpc().state({})).requests[0]
  await h.rpc().dismissRequest({ id: request.id })
  assert.deepEqual((await h.rpc().state({})).requests, [])
  await h.rpc().setSecret({ id: "home", secret: CLIENT_SECRET })
  const started = await h.rpc().signIn({ id: "home" })
  await fake.approve(started.url)
  for (let i = 0; i < 100 && !(await h.rpc().state({})).accounts[0].who; i++) await new Promise(r => setTimeout(r, 30))
  const state = await h.rpc().state({ sessionID: "s" })
  assert.equal(state.accounts[0].who, "Pat Lee")
  await h.rpc().setCells({ changes: [{ entity: "home", capability: "share", effect: "deny", agent: "*" }] })
  const exported = await h.rpc().exportBundle({ passphrase: "export passphrase 1" })
  assert.ok(!exported.content.includes(CLIENT_SECRET))
  const other = await host()
  await other.rpc().applyImport({ content: exported.content, passphrase: "export passphrase 1", mode: "merge" })
  assert.equal((await other.call("google_api", { api: "drive", path: "about", query: { fields: "user" } })).user.emailAddress, "pat@example.com", "the imported sign-in works")
  assert.equal((await other.rpc().state({})).cells.home["*"].share, "deny")
  await assert.rejects(other.call("google_api", { api: "drive", method: "POST", path: "files/f-doc/permissions", body: { type: "anyone", role: "reader" } }), /Denied by the oc-google permissions table \(share on home\)/)
  await other.rpc().signOut({ id: "home" })
  assert.equal((await other.rpc().state({})).accounts[0].signedIn, false)
})
