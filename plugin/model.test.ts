import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyRequest, contentTypeOf, defaultEffect, explainApiError, explainSignInError, exportFormat, normalizeAccount, planRclone, rcloneEnv, requestedScopes, resolveApi, sortKinds } from "./model.js"
import { withQuery } from "./tools.js"

const CLIENT = "123456789012-abcdefgh12345678.apps.googleusercontent.com"

test("accounts: defaults, presets and validation; secrets are refused", () => {
  const account = normalizeAccount({ id: "personal", clientId: CLIENT, email: "Pat@Example.COM" }, new Date(0))
  assert.deepEqual(account, { id: "personal", preset: "full", clientId: CLIENT, email: "pat@example.com", updatedAt: "1970-01-01T00:00:00.000Z" })
  assert.deepEqual(requestedScopes(account), ["openid", "email", "https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/presentations"])
  const read = requestedScopes(normalizeAccount({ id: "r", preset: "read" }))
  assert.ok(read.includes("https://www.googleapis.com/auth/drive.readonly") && read.every(scope => !/\/(drive|documents|spreadsheets|presentations)$/.test(scope)))
  assert.deepEqual(requestedScopes(normalizeAccount({ id: "c", preset: "custom", scopes: ["drive.file", "openid"] })), ["https://www.googleapis.com/auth/drive.file", "openid"])
  assert.throws(() => normalizeAccount({ id: "c", preset: "custom" }), /scopes/)
  assert.throws(() => normalizeAccount({ id: "c", preset: "custom", scopes: ["https://evil.example/x"] }), /not a Google OAuth scope/)
  assert.throws(() => normalizeAccount({ id: "c", clientId: "not-a-client" }), /apps\.googleusercontent\.com/)
  assert.throws(() => normalizeAccount({ id: "c", clientSecret: "GOCSPX-x" }), /never passed here: use google_request_secret/)
  assert.throws(() => normalizeAccount({ id: "bad id" }), /account id/)
  assert.equal(normalizeAccount({ id: "n" }).clientId, undefined, "a client ID can be added later")
})

test("paths resolve to the right API and host prefix", () => {
  assert.deepEqual(resolveApi("files?q=x", "drive"), { api: "drive", path: "/drive/v3/files?q=x" })
  assert.deepEqual(resolveApi("/drive/v3/about"), { api: "drive", path: "/drive/v3/about" })
  assert.deepEqual(resolveApi("/upload/drive/v3/files?uploadType=media"), { api: "drive", path: "/upload/drive/v3/files?uploadType=media" })
  assert.deepEqual(resolveApi("documents/abc:batchUpdate", "docs"), { api: "docs", path: "/v1/documents/abc:batchUpdate" })
  assert.deepEqual(resolveApi("/v1/documents/abc"), { api: "docs", path: "/v1/documents/abc" })
  assert.deepEqual(resolveApi("spreadsheets/s1/values/Sheet1!A1:B2", "sheets"), { api: "sheets", path: "/v4/spreadsheets/s1/values/Sheet1!A1:B2" })
  assert.deepEqual(resolveApi("/v1/presentations/p1:batchUpdate"), { api: "slides", path: "/v1/presentations/p1:batchUpdate" })
  assert.deepEqual(resolveApi("https://sheets.googleapis.com/v4/spreadsheets/s1"), { api: "sheets", path: "/v4/spreadsheets/s1" })
  assert.throws(() => resolveApi("https://evil.example/drive/v3/files"), /Only Google Drive, Docs, Sheets and Slides API URLs/)
  assert.throws(() => resolveApi("https://docs.googleapis.com/drive/v3/files"), /does not serve/)
  assert.throws(() => resolveApi("files"), /Cannot tell which API/)
  assert.throws(() => resolveApi("/v1/documents/x", "sheets"), /is a docs path/)
  assert.throws(() => resolveApi("presentations/x", "docs"), /not a docs path/)
  assert.equal(withQuery("/drive/v3/files?pageSize=5", { q: "name contains 'a b'", fields: "files(id,name)" }), "/drive/v3/files?pageSize=5&q=name%20contains%20%27a%20b%27&fields=files%28id%2Cname%29")
})

test("requests are classified: read, write, share (who has access), delete (permanent)", () => {
  const cases: [string, string, string][] = [
    ["GET", "/drive/v3/files?q=trashed%3Dfalse", "read"], ["GET", "/drive/v3/files/abc?alt=media", "read"], ["GET", "/drive/v3/files/abc/export?mimeType=text/markdown", "read"],
    ["GET", "/drive/v3/about?fields=user", "read"], ["GET", "/drive/v3/files/abc/permissions", "read"], ["GET", "/drive/v3/files/abc/revisions", "read"],
    ["GET", "/drive/v3/files/abc/comments?fields=*", "read"], ["POST", "/drive/v3/files/abc/download?mimeType=video/mp4", "read"],
    ["POST", "/drive/v3/files", "write"], ["PATCH", "/drive/v3/files/abc", "write"], ["PATCH", "/drive/v3/files/abc?addParents=f1&removeParents=root", "write"],
    ["POST", "/drive/v3/files/abc/copy", "write"], ["POST", "/upload/drive/v3/files?uploadType=multipart", "write"], ["PATCH", "/upload/drive/v3/files/abc?uploadType=media", "write"],
    ["POST", "/drive/v3/files/abc/comments?fields=id", "write"], ["POST", "/drive/v3/files/abc/watch", "write"], ["POST", "/drive/v3/drives?requestId=1", "write"],
    ["POST", "/drive/v3/files/abc/permissions", "share"], ["POST", "/drive/v3/files/abc/permissions?sendNotificationEmail=false", "share"],
    ["PATCH", "/drive/v3/files/abc/permissions/p1", "share"], ["DELETE", "/drive/v3/files/abc/permissions/p1", "share"],
    ["POST", "/drive/v3/files/abc/permissions?transferOwnership=true", "share"], ["PATCH", "/drive/v3/files/abc/permissions/p1?transferOwnership=true", "share"],
    ["POST", "/drive/v3/drives/d1/permissions", "share"], ["POST", "/drive/v3/files/abc/accessproposals/ap1:resolve", "share"],
    ["DELETE", "/drive/v3/files/abc", "delete"], ["DELETE", "/drive/v3/files/trash", "delete"], ["DELETE", "/drive/v3/files/abc/revisions/r1", "delete"],
    ["DELETE", "/drive/v3/files/abc/comments/c1", "delete"], ["DELETE", "/drive/v3/drives/d1", "delete"],
    ["GET", "/v1/documents/d1", "read"], ["POST", "/v1/documents/d1:batchUpdate", "write"], ["POST", "/v1/documents", "write"],
    ["GET", "/v4/spreadsheets/s1/values/A1:B2", "read"], ["GET", "/v4/spreadsheets/s1/values:batchGet?ranges=A1", "read"],
    ["PUT", "/v4/spreadsheets/s1/values/A1:B2?valueInputOption=RAW", "write"], ["POST", "/v4/spreadsheets/s1/values/A1:append?valueInputOption=USER_ENTERED", "write"],
    ["POST", "/v4/spreadsheets/s1/values:batchUpdate", "write"], ["POST", "/v4/spreadsheets/s1/values:batchClear", "write"], ["POST", "/v4/spreadsheets/s1:batchUpdate", "write"],
    ["POST", "/v4/spreadsheets/s1/values:batchGetByDataFilter", "read"], ["POST", "/v4/spreadsheets/s1:getByDataFilter", "read"], ["POST", "/v4/spreadsheets/s1/developerMetadata:search", "read"],
    ["GET", "/v1/presentations/p1", "read"], ["GET", "/v1/presentations/p1/pages/g1/thumbnail", "read"], ["POST", "/v1/presentations/p1:batchUpdate", "write"], ["POST", "/v1/presentations", "write"],
  ]
  for (const [method, path, expected] of cases) assert.equal(classifyRequest(method, resolveApi(path)), expected, `${method} ${path}`)
  assert.deepEqual(sortKinds(["delete", "read", "share", "read", "write"]), ["read", "write", "share", "delete"])
})

test("defaults: reads and own edits allowed; sharing, permanent deletes and removing an account ask", () => {
  for (const capability of ["read", "write", "manage"]) assert.equal(defaultEffect(capability), "allow")
  for (const capability of ["share", "delete", "remove"]) assert.equal(defaultEffect(capability), "ask")
})

test("exports: defaults per type, formats by extension or MIME type", () => {
  assert.deepEqual(exportFormat("application/vnd.google-apps.document"), { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" })
  assert.deepEqual(exportFormat("application/vnd.google-apps.document", "md"), { mimeType: "text/markdown", extension: "md" })
  assert.deepEqual(exportFormat("application/vnd.google-apps.document", "markdown"), { mimeType: "text/markdown", extension: "md" })
  assert.deepEqual(exportFormat("application/vnd.google-apps.spreadsheet", "text/csv"), { mimeType: "text/csv", extension: "csv" })
  assert.equal(exportFormat("application/vnd.google-apps.spreadsheet").extension, "xlsx")
  assert.equal(exportFormat("application/vnd.google-apps.presentation").extension, "pptx")
  assert.equal(exportFormat("application/vnd.google-apps.drawing").extension, "png")
  assert.equal(exportFormat("application/vnd.google-apps.drawing", "jpeg").mimeType, "image/jpeg")
  assert.throws(() => exportFormat("application/vnd.google-apps.presentation", "csv"), /exports as pptx, odp, pdf, txt/)
  assert.throws(() => exportFormat("application/vnd.google-apps.form"), /cannot be exported/)
  assert.equal(contentTypeOf("notes.MD"), "text/markdown")
  assert.equal(contentTypeOf("a.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  assert.equal(contentTypeOf("blob"), "application/octet-stream")
})

test("sign-in and API errors explained in plain words", () => {
  const account = normalizeAccount({ id: "p", clientId: CLIENT, email: "pat@example.com" })
  assert.match(explainSignInError("client_user_mismatch", undefined, account), /only the Google account that created it can sign in.*pat@example\.com/)
  assert.match(explainSignInError("access_denied", undefined, account), /declined/)
  assert.match(explainSignInError("admin_policy_enforced", undefined, account), /administrator/)
  assert.match(explainSignInError("invalid_grant", "Token has been expired or revoked.", account), /sign in again/)
  assert.match(explainSignInError("redirect_uri_mismatch", undefined, account), /Desktop app/)
  assert.match(explainSignInError("invalid_client", "Unauthorized", account), /Desktop app.*google_request_secret/)
  assert.match(explainSignInError("deleted_client", undefined, account), /Restore it within 30 days/)
  const disabled = { error: { code: 403, message: "Google Docs API has not been used in project 42 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { service: "docs.googleapis.com", consumer: "projects/42", serviceTitle: "Google Docs API" } }] } }
  assert.equal(explainApiError(403, disabled, "docs"), "The Google Docs API is not enabled in the Google Cloud project of your OAuth client (42). Enable it at https://console.cloud.google.com/apis/library/docs.googleapis.com?project=42, wait a minute, then retry.")
  const legacy = { error: { code: 403, message: "Access Not Configured. Google Sheets API has not been used in project 7 before or it is disabled.", errors: [{ reason: "accessNotConfigured" }] } }
  assert.match(explainApiError(403, legacy, "sheets")!, /Google Sheets API is not enabled.*apis\/library\/sheets\.googleapis\.com\?project=7/)
  assert.match(explainApiError(403, { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } }, "drive")!, /scope/)
  assert.equal(explainApiError(404, { error: { code: 404, message: "File not found" } }, "drive"), undefined)
})

test("rclone commands: which use gdrive: and what they need", () => {
  const plan = (command: string) => planRclone(command)
  assert.deepEqual(plan("ls -la"), { uses: false, kinds: [], login: false })
  assert.equal(plan("rclone lsd other:").uses, false)
  assert.equal(plan("rclone copy ./a ./b").uses, false)
  assert.deepEqual(plan("rclone lsd gdrive:").kinds, ["read"])
  assert.deepEqual(plan("pixi exec --spec rclone rclone lsjson gdrive:Photos -R").kinds, ["read"])
  assert.deepEqual(plan("rclone copy gdrive:docs ./local").kinds, ["read"])
  assert.deepEqual(plan("rclone copy ./local gdrive:backup --progress").kinds, ["write"])
  assert.deepEqual(plan("rclone sync ./site 'gdrive:My Site'").kinds, ["write"], "sync deletes go to the trash")
  assert.deepEqual(plan("rclone sync ./site gdrive:site --drive-use-trash=false").kinds, ["delete"])
  assert.deepEqual(plan("rclone move gdrive:a gdrive:b").kinds, ["write"])
  assert.deepEqual(plan("rclone delete gdrive:tmp").kinds, ["delete"])
  assert.deepEqual(plan("rclone purge gdrive:tmp").kinds, ["delete"])
  assert.deepEqual(plan("rclone cleanup gdrive:").kinds, ["delete"], "empties the trash")
  assert.deepEqual(plan("rclone link gdrive:report.pdf").kinds, ["share"])
  assert.deepEqual(plan("rclone mkdir gdrive:new && rclone lsd gdrive:").kinds, ["read", "write"])
  assert.deepEqual(plan("rclone mount gdrive: ~/gd --daemon").kinds, ["write"])
  assert.deepEqual(plan("rclone serve http gdrive: --read-only").kinds, ["read"])
  assert.deepEqual(plan("rclone backend features gdrive:").kinds, ["read"])
  assert.equal(plan("rclone config reconnect gdrive:").login, true)
  assert.equal(plan("rclone about gdrive:").login, false)
})

test("rclone environment", () => {
  const env = rcloneEnv("gdrive", "id.apps.googleusercontent.com", "s3cret", "ya29.abc", "1//r", 1_800_000_000_000, false)
  assert.equal(env.RCLONE_CONFIG_GDRIVE_TYPE, "drive")
  assert.equal(env.RCLONE_CONFIG_GDRIVE_SCOPE, "drive")
  assert.deepEqual(JSON.parse(env.RCLONE_CONFIG_GDRIVE_TOKEN!), { access_token: "ya29.abc", token_type: "Bearer", refresh_token: "1//r", expiry: new Date(1_800_000_000_000).toISOString() })
  assert.equal(rcloneEnv("gdrive", "i", "s", "a", undefined, 0, true).RCLONE_CONFIG_GDRIVE_SCOPE, "drive.readonly")
})
