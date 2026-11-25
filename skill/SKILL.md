---
name: google
description: Work effectively in Google Drive, Docs, Sheets and Slides through the oc-google tools — finding files (Drive v3 q syntax, fields masks, paging, shared drives), folders, moving, copying, uploading and converting, exporting (docx, xlsx, pptx, pdf, Markdown, csv), sharing and permissions, revisions and comments, editing Docs (batchUpdate, UTF-16 indexes, write backwards), Sheets (A1 ranges, values, valueInputOption, batchUpdate) and Slides, and setting up the user's own OAuth client. Load before non-trivial Google Workspace file work.
---

# Working in Google Drive, Docs, Sheets and Slides

## Tools

- `google_api` — any request to Drive v3, Docs v1, Sheets v4 or Slides v1 as the signed-in user. Give `api`
  (`drive`, `docs`, `sheets`, `slides`) with a path relative to it (`files`, `documents/{id}:batchUpdate`,
  `spreadsheets/{id}/values/Sheet1!A1:D20`), or a full path (`/drive/v3/…`, `/upload/drive/v3/…`, `/v1/documents/…`,
  `/v4/spreadsheets/…`, `/v1/presentations/…`). Put URL parameters in `query` (they are encoded for you), JSON in
  `body`. Headers: only `If-Match` / `If-None-Match`. Output over 60k characters is cut.
- `google_download fileId=… to=…` — regular files as they are; Google Docs/Sheets/Slides/Drawings are exported with
  `format` (default docx/xlsx/pptx/png; also `pdf`, `md`, `txt`, `html`, `csv`, `tsv`, `odt`, `ods`, `odp`, `rtf`,
  `epub`, `jpg`, `svg`). `to` ending in `/` keeps the Drive name. `path=` downloads a raw Drive path (e.g. a revision).
- `google_upload from=… ` — new file (`name`, `parents: [folderId]`) or `fileId` to replace an existing file's content
  (same ID, sharing and history). `convert: document|spreadsheet|presentation` imports Word/Markdown/HTML/text,
  Excel/CSV, PowerPoint as native Google files. Any size (resumable above 5 MB).
- `google_list` — accounts, who is signed in, granted scopes, what you may do. Setup: see the end.
- **rclone** in the shell: the `gdrive:` remote is supplied with the signed-in account to every rclone command that
  names it — never run `rclone config`/`authorize` (that opens a browser). Not installed? `pixi exec --spec rclone
  rclone …`. Good for bulk or recursive transfers and syncing folders: `rclone copy ./out gdrive:Backups/out -P`,
  `rclone lsf gdrive:Folder`, `rclone size gdrive:`. Google Docs/Sheets/Slides download as docx/xlsx/pptx
  (`--drive-export-formats md,csv,pdf` to change). Deletes go to the Drive trash; `delete`, `purge`, `cleanup`,
  `--drive-use-trash=false` and `link` ask the user. Another account: `OC_GOOGLE_ACCOUNT=<id> rclone …`.

Permissions (defaults): reading, creating, editing, moving, copying, uploading and **trashing** run; **anything that
changes who has access** (permissions create/update/delete, link sharing, ownership transfer, access requests) and
**permanent deletes** (`DELETE files/{id}`, emptying the trash, deleting revisions, comments or shared drives) ask the
user. Prefer the trash (`PATCH files/{id}` `{trashed:true}`) over deleting: it can be undone for 30 days.

## Drive v3

**Always set `fields`.** Without it `files.list` returns only `kind,id,name,mimeType,resourceKey`; with it you get
exactly what you name: `fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,webViewLink)`.
Sub-fields use `/` or parentheses: `files(id,capabilities/canEdit)`. `fields=*` is for debugging only.
The comments and replies endpoints *require* `fields`.

Search with `q` (`query: {q: "…"}`); strings in single quotes, escape `'` and `\` with a backslash:

| Want | `q` |
|---|---|
| name contains a word | `name contains 'budget' and trashed = false` |
| exact name | `name = 'Project Plan'` |
| content | `fullText contains 'quarterly revenue'` (phrase: `fullText contains '"hello world"'`) |
| in a folder | `'FOLDER_ID' in parents and trashed = false` (root: `'root' in parents`) |
| folders only | `mimeType = 'application/vnd.google-apps.folder'` |
| Google Docs / Sheets / Slides | `mimeType = 'application/vnd.google-apps.document'` (`.spreadsheet`, `.presentation`) |
| PDFs, images | `mimeType = 'application/pdf'`, `mimeType contains 'image/'` |
| changed recently | `modifiedTime > '2026-11-01T00:00:00'` (UTC) |
| shared with me | `sharedWithMe and name contains 'hello'` |
| owned by / editable by | `'pat@example.com' in owners`, `'pat@example.com' in writers` |
| starred, link-shared | `starred = true`, `visibility = 'anyoneWithLink'` |

Combine with `and`, `or`, `not`, parentheses. Without `orderBy` the order is arbitrary: use
`orderBy=modifiedTime desc` (prefer `modifiedTime` over `createdTime` on large collections) or `name`.
Paging: `pageSize` up to 1000; follow `nextPageToken` → `pageToken` only as far as needed.

Shared drives: add `supportsAllDrives=true` to every call that touches a file that may be in one, and for lists
`includeItemsFromAllDrives=true&corpora=allDrives` (all) or `corpora=drive&driveId=…` (one). Check
`incompleteSearch` in the response; narrow to `user` or `drive` when it is true. List shared drives: `GET drives`.

Common operations (`api: drive`):

- Metadata: `GET files/{id}` `fields=id,name,mimeType,size,parents,owners(emailAddress),modifiedTime,webViewLink,capabilities/canEdit`.
- Folder: `POST files` `{name, mimeType: "application/vnd.google-apps.folder", parents: [parentId]}`.
- Create an empty Google Doc/Sheet/Slides: same with `mimeType: application/vnd.google-apps.document` (or the Docs,
  Sheets, Slides `create` endpoints, which return the native structure).
- Rename / describe: `PATCH files/{id}` `{name, description}`.
- Move: `PATCH files/{id}` with `query: {addParents: NEW, removeParents: OLD}` (read the current `parents` first).
  A file has one parent; folders cannot be moved from My Drive into a shared drive this way.
- Copy: `POST files/{id}/copy` `{name, parents}` (also the way to "make a copy" of a template document).
- Trash / restore: `PATCH files/{id}` `{trashed: true|false}`. Permanent: `DELETE files/{id}`, `DELETE files/trash`.
- Storage and the user: `GET about` `fields=user,storageQuota`; possible import/export conversions:
  `fields=importFormats,exportFormats`.

Download and export: `google_download` (it uses `alt=media` for binary files and `files/{id}/export` for Google files).
**Exports are limited to 10 MB**; for bigger Docs export `pdf`, read natively with the Docs/Sheets API, or use
`POST files/{id}/download?mimeType=…` (a long-running operation; poll the returned operation, then fetch its
`downloadUri`). CSV/TSV export contains only the **first sheet**; for other sheets read values with the Sheets API.
Partial downloads (`Range`) are not supported for exports.

Sharing (asks the user): `POST files/{id}/permissions` `{type, role, emailAddress | domain}`.
Roles: `owner`, `organizer` and `fileOrganizer` (shared drives), `writer`, `commenter`, `reader`.
Types: `user`, `group`, `domain`, `anyone` (link sharing — avoid unless the user asked; prefer specific people).
`sendNotificationEmail=false` to skip the email (only allowed for users and groups); `emailMessage` adds a note.
Ownership: Workspace accounts in the same domain: `transferOwnership=true` with `role: owner`. Between personal (consumer) accounts it is two steps: the owner creates or updates the other person's permission with `role: writer, type: user, pendingOwner: true`; the new owner then accepts (they must do it themselves).
List: `GET files/{id}/permissions` `fields=permissions(id,type,role,emailAddress,domain)`. Change: `PATCH …/permissions/{pid}`
`{role}`; remove: `DELETE …/permissions/{pid}`. Show the user exactly who gets which role before sharing.

Revisions: `GET files/{id}/revisions` `fields=revisions(id,modifiedTime,lastModifyingUser/displayName,keepForever)`;
download a blob revision with `google_download path=/drive/v3/files/{id}/revisions/{rev}?alt=media`
(only "Keep Forever" revisions; Google files: use the revision's `exportLinks`). Old blob revisions are purged after
about 30 days unless `keepForever: true`.

Comments: `GET files/{id}/comments` `fields=comments(id,content,author/displayName,resolved,quotedFileContent,replies(content,author/displayName))`;
add `POST files/{id}/comments` `fields=id` `{content}`; reply `POST files/{id}/comments/{cid}/replies` `fields=id` `{content}`
(a reply with `action: "resolve"` resolves the comment). Drive treats the anchors of comments made in the Docs, Sheets or Slides editors as opaque; comments added through Drive show as unanchored ("All comments").

## Google Docs (`api: docs`)

- Read: `GET documents/{id}`. Text lives in `body.content[]` → `paragraph.elements[]` → `textRun.content`, each element
  with `startIndex`/`endIndex`. Documents with tabs: `query: {includeTabsContent: true}` puts content in
  `tabs[].documentTab.body` (without it you get only the first tab). For just the text, `google_download format=md`
  (or `txt`) is far smaller than the JSON.
- Edit: `POST documents/{id}:batchUpdate` `{requests: [...]}` — applied in order, atomically (all or nothing).
  - `insertText` `{text, location: {index}}` or `{text, endOfSegmentLocation: {}}` (append to the body).
  - `deleteContentRange` `{range: {startIndex, endIndex}}`.
  - `replaceAllText` `{containsText: {text, matchCase: true}, replaceText}` — the simplest safe edit; use it for
    templates (`{{name}}` placeholders) and corrections.
  - `updateTextStyle` / `updateParagraphStyle` `{range, textStyle | paragraphStyle, fields: "bold"}`,
    `createParagraphBullets`, `insertTable`, `insertInlineImage`, `insertPageBreak`.
- **Indexes are UTF-16 code units** (an emoji counts 2) and the body starts at index 1. Every insert or delete shifts
  everything after it, so **write backwards**: order the requests from the highest index to the lowest, and each one
  stays valid. Text must be inserted inside an existing paragraph; the final newline of the body cannot be deleted.
- Concurrency: send `writeControl: {requiredRevisionId}` (from the `revisionId` you read) to fail instead of editing a
  document that changed meanwhile.

## Google Sheets (`api: sheets`)

- Structure: `GET spreadsheets/{id}` `fields=sheets.properties(sheetId,title,gridProperties)` (never fetch `includeGridData`
  on big sheets).
- A1 notation: `Sheet1!A1:D10`, `Sheet1!A:A`, `'My Sheet'!B2` (quote names with spaces); without a sheet name the
  first sheet is used.
- Read: `GET spreadsheets/{id}/values/{range}` (`valueRenderOption`: `FORMATTED_VALUE` default, `UNFORMATTED_VALUE`,
  `FORMULA`); several ranges: `GET spreadsheets/{id}/values:batchGet` with `ranges` repeated. Empty trailing rows and
  columns are omitted.
- Write: `PUT spreadsheets/{id}/values/{range}` `query: {valueInputOption: "USER_ENTERED"}` `{values: [[…], […]]}`.
  `valueInputOption` is required: `USER_ENTERED` parses like typing in the UI (formulas, dates, `$1.50`), `RAW` stores
  strings as they are. `""` clears a cell; values with no data are skipped.
- Append rows after a table: `POST spreadsheets/{id}/values/{range}:append` with `valueInputOption` (and
  `insertDataOption=INSERT_ROWS` to insert rather than overwrite empty rows).
- Many ranges at once: `POST spreadsheets/{id}/values:batchUpdate` `{valueInputOption, data: [{range, values}]}`;
  clear: `values:batchClear`.
- Structure and formatting: `POST spreadsheets/{id}:batchUpdate` `{requests: [...]}` — `addSheet {properties: {title}}`,
  `deleteSheet {sheetId}`, `updateSheetProperties`, `repeatCell {range: {sheetId, startRowIndex, endRowIndex, …},
  cell: {userEnteredFormat: {…}}, fields: "userEnteredFormat(textFormat,backgroundColor)"}`, `autoResizeDimensions`,
  `insertDimension`, `sortRange`, `addConditionalFormatRule`. GridRange indexes are zero-based, end-exclusive, and use
  the numeric `sheetId`, not the title.
- New spreadsheet: `POST spreadsheets` `{properties: {title}, sheets: [{properties: {title: "Data"}}]}`.

## Google Slides (`api: slides`)

- Read: `GET presentations/{id}` `fields=slides(objectId,pageElements(objectId,shape(text(textElements(textRun/content)))))`;
  thumbnails: `GET presentations/{id}/pages/{pageId}/thumbnail`.
- Edit: `POST presentations/{id}:batchUpdate` `{requests: [...]}` — `createSlide {objectId?, insertionIndex?,
  slideLayoutReference: {predefinedLayout: "TITLE_AND_BODY"}, placeholderIdMappings}`, `insertText {objectId, text,
  insertionIndex}`, `deleteText`, `replaceAllText {containsText: {text, matchCase}, replaceText, pageObjectIds?}`,
  `createShape`, `createImage`, `updateTextStyle`, `deleteObject`. Your own object IDs must be 5–50 characters
  (`[a-zA-Z0-9_]` first, then also `-` and `:`).
- To fill a deck from a template: copy it (`POST files/{id}/copy`), then `replaceAllText` for each placeholder.

## Native editing or export/import?

- Read for understanding: export to `md` (Docs), `csv` (one sheet) or `txt` (Slides) — small and readable.
- Small, targeted changes that must keep formatting, comments, suggestions and history: native `batchUpdate`
  (`replaceAllText` first; index-based edits for the rest).
- A full rewrite or a new document from Markdown: write the Markdown locally and `google_upload convert=document`
  (new file), or `fileId` + `convert=document` to replace the whole content (formatting and anchored comments of the
  old version are lost; the revision history keeps it). Same for CSV/Excel → `spreadsheet`, PowerPoint → `presentation`.
- Office files the user wants to keep as Office files: download, edit locally, upload with `fileId` (no `convert`).

## Errors

401: sign-in expired — the plugin refreshes automatically; if it persists, `google_signin`. 403
`insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: the account's preset is `read` or a scope was unticked
at sign-in. 403 `SERVICE_DISABLED` / "has not been used in project … or it is disabled": that API is not enabled in the
user's Cloud project — tell the user the link in the error, then retry after a minute. 403 `exportSizeLimitExceeded`:
the 10 MB export limit. 403 `fileNotDownloadable`: a Google file — export instead. 404: wrong ID, no access, or a
shared-drive file without `supportsAllDrives=true`. 429 / 403 `rateLimitExceeded`, `userRateLimitExceeded`: wait and
retry with backoff. 400 on Docs `batchUpdate`: an index is out of range or not inside a paragraph — re-read the
document and write backwards.

## Setup (once, by the user)

1. https://console.cloud.google.com/auth/overview/personal, signed in as the Google account to use: application type
   **Desktop app** → Continue; copy the Client ID and the Client secret (shown only once). Personal mode needs no app
   verification and its refresh tokens do not expire after 7 days, but **only the account that created it can sign
   in** (`client_user_mismatch` otherwise).
2. Enable the Google Drive API, Google Docs API, Google Sheets API and Google Slides API for the same project in
   https://console.cloud.google.com/apis/library.
3. `google_account_upsert id=personal clientId=….apps.googleusercontent.com email=…` → `google_request_secret` (the
   user enters the secret in OpenCode's Google view or with `pixi run secret-set`; never ask for it in the chat) →
   `google_signin` and give the user the link.

Sign-in errors: `access_denied` (declined), `client_user_mismatch` (not the creator account), `admin_policy_enforced`
(Workspace admin blocks the scopes), `invalid_client` / `redirect_uri_mismatch` (wrong secret or not a Desktop app
client), `deleted_client` (restore within 30 days or create a new client), `invalid_grant` (expired or revoked: sign in
again).
