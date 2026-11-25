// Google sign-in for an account from a terminal (the GUI and google_signin do the same).
//   pixi run signin <account> [--client-id <id>.apps.googleusercontent.com] [--email you@gmail.com] [--read-only]
// The client secret must be stored first (pixi run secret-set <account>). Never prints tokens or the secret.
import { spawn } from "node:child_process"
import { pluginDataDir } from "oc-secure-kit"
import { mergeAccount, normalizeAccount, SETUP_STEPS } from "../plugin/model.ts"
import { GoogleService } from "../plugin/service.ts"

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined }
const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined
if (!id) { console.error("Usage: pixi run signin <account> [--client-id <id>.apps.googleusercontent.com] [--email you@gmail.com] [--read-only]"); process.exit(2) }
const service = await GoogleService.open(pluginDataDir("oc-google", process.env.OC_GOOGLE_DATA_DIR || undefined))
let account = await service.store.get(id)
const patch = { ...(option("--client-id") && { clientId: option("--client-id") }), ...(option("--email") && { email: option("--email") }), ...(args.includes("--read-only") && { preset: "read" }) }
if (!account || Object.keys(patch).length) account = await service.store.put(normalizeAccount({ ...mergeAccount(account, patch), id }))
if (!account.clientId) { console.error(`No client ID for ${id}. Setup:\n${SETUP_STEPS.join("\n")}\nThen: pixi run signin ${id} --client-id <id>.apps.googleusercontent.com`); process.exit(1) }
if ((await service.secretStatus(account)) === "unset") { console.error(`Enter the client secret first: pixi run secret-set ${id}`); process.exit(1) }
let state
try { state = await service.startSignIn(account) }
catch (error) { console.error(error.message); process.exit(1) }
console.log(`\nOpening your browser. Sign in${account.email ? ` as ${account.email}` : ""} and allow access. If it does not open, visit:\n\n${state.url}\n`)
spawn(process.platform === "darwin" ? "open" : "xdg-open", [state.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
while (state.status === "waiting") await new Promise(resolve => setTimeout(resolve, 500))
if (state.status !== "done") { console.error(state.error); process.exit(1) }
const d = await service.store.discovery(id)
console.log(d?.error ? `Signed in, but: ${d.error}` : `Signed in as ${d?.name} <${d?.email}>. Granted: ${(d?.granted ?? []).join(" ")}.`)
service.dispose(); process.exit(0)
