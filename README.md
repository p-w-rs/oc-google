# oc-google

Google Drive, Docs, Sheets and Slides for OpenCode agents: find, read, export, upload and organize Drive files, and
edit Google Docs, Sheets and Slides natively, as the signed-in user, through your **own** Google OAuth client.
Changing who has access (sharing, ownership) and permanent deletes ask first by default, and the built-in `google`
skill teaches agents the Drive query syntax, `fields` masks, exports, and how to edit Docs safely.
macOS and Linux; the current OpenCode (2.4.2) and Pixi.

## Setup: your own OAuth client (once, about 3 minutes)

Google does not offer a shared client for this, so you create one for yourself in **Personal mode**: no app
verification, no 7-day token expiry, no "unverified app" screen — and only your Google account can use it
(any other account gets `client_user_mismatch`).

1. Open <https://console.cloud.google.com/auth/overview/personal>, signed in as the Google account you want to use.
   Select or create the Personal-mode project, choose application type **Desktop app**, accept the terms and click
   **Continue**.
2. Copy the **Client ID** (`….apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-…`). The secret is
   shown only once (or download the JSON). If you lose it, add a new secret to the client under
   Google Auth Platform → Clients.
3. Enable the four APIs for the same project (open each, click **Enable**):
   [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com),
   [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com),
   [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com),
   [Google Slides API](https://console.cloud.google.com/apis/library/slides.googleapis.com).
   (A missing one shows up later as "… API has not been used in project … or it is disabled"; the plugin names the
   API and links to it.)
4. In OpenCode, either
   - open **Settings → Google** (or `/google` in a session), click **Add account**, paste the Client ID and the
     Client secret, and sign in in the browser; or
   - ask your agent ("connect my Google Drive"): it calls `google_account_upsert` with the Client ID and your email,
     then `google_request_secret` — you enter the secret in the Google view (or in a terminal:
     `pixi run secret-set personal`), never in the chat — then `google_signin` and gives you the link; or
   - in a terminal in this folder: `pixi run secret-set personal` after
     `pixi run signin personal --client-id <id>.apps.googleusercontent.com --email you@gmail.com` tells you to.

Sign-in uses the browser on the OpenCode computer (a loopback redirect to `http://127.0.0.1:<port>`, PKCE). Google's
device-code flow does not allow Drive scopes, so there is no code-on-another-device option. The client secret, access
and refresh tokens are stored encrypted in `~/.local/share/oc-google` and are never shown to agents (tool output is
also scanned and masked).

Google Workspace accounts work too if your administrator allows them to use their own OAuth clients
(otherwise `admin_policy_enforced`).

| Preset | Scopes |
|---|---|
| `full` (default) | openid, email, drive, documents, spreadsheets, presentations |
| `read` | openid, email, drive.readonly, documents.readonly, spreadsheets.readonly, presentations.readonly |
| `custom` | your list (e.g. `drive.file`) |

## What agents get

| Tool | |
|---|---|
| `google_list` | Accounts, who is signed in, storage used, granted scopes, what the agent may do |
| `google_api` | Any Drive v3, Docs v1, Sheets v4 or Slides v1 request (`api` + path, `query`, JSON `body`) |
| `google_download` | Files to disk; Google Docs/Sheets/Slides/Drawings exported (docx, xlsx, pptx, pdf, md, csv, …) |
| `google_upload` | Files to Drive (any size), new or replacing a file's content; optional conversion to Google formats |
| `google_account_upsert` / `_remove`, `google_request_secret`, `google_signin`, `google_refresh` | Setup |

**rclone** works without its own login: any `rclone` command in the agent's shell that names the `gdrive:` remote
(`rclone lsd gdrive:`, `rclone copy ./out gdrive:backup`, also through `pixi exec --spec rclone rclone …`) gets the
signed-in account as environment variables for that one command (your OAuth client and token; nothing is written to
disk, secrets are masked in the output). The same permissions apply: reads and uploads run; `rclone delete`, `purge`,
`cleanup` and `--drive-use-trash=false` count as delete and `rclone link` as share, so they ask. Several accounts:
`OC_GOOGLE_ACCOUNT=<id> rclone …`. If your own `rclone.conf` defines a `[gdrive]` remote, it is used as it is.

## Permissions

Per account: **read**, **write** (create, edit, move, copy, upload, trash), **share** (anything that changes who has
access), **delete** (permanent deletion, emptying the trash), plus edit/remove account. Each request is classified by
method and path. Defaults: read and write run; share, delete and removing an account ask. Editable in the GUI
(`/google`, the Review-pane **+** menu, or **Settings → Google**); **Allow always** on a prompt writes allow.

## Install

Requires the current [OpenCode](https://opencode.ai) (2.4.2; CLI or Desktop) and [Pixi](https://pixi.sh); macOS or Linux.

```sh
git clone https://github.com/p-w-rs/oc-google.git && cd oc-google
pixi run --locked install          # runs the tests, then installs a verified snapshot into your OpenCode config
```

OpenCode picks up the change (or `/reload`). Then follow **Setup** above.

```sh
pixi run --locked install-status   # what is installed, and whether its files are intact
pixi run --locked rollback         # back to the previous snapshot
pixi run --locked uninstall        # removes only this plugin's entry; your data stays
```

Updating: `git pull && pixi run --locked install`. Accounts, secrets, sign-ins and permissions live in
`~/.local/share/oc-google` and survive updates; move them between computers with **Export** / **Import** in the view
(an encrypted file). Removing an account revokes the plugin's access at Google.

## Development

```sh
pixi run --locked test            # fake Google OAuth + Drive/Docs/Sheets/Slides
pixi run --locked smoke-host      # real OpenCode CLI (pinned in the script), scripted model, fake Google
```
