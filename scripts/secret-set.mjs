// Enter the OAuth client secret of an account's Desktop app client. Read with echo off, or from stdin.
//   pixi run secret-set <account>
import { createInterface } from "node:readline"
import { pluginDataDir } from "oc-secure-kit"
import { GoogleService } from "../plugin/service.ts"

const [id] = process.argv.slice(2)
if (!id) { console.error("Usage: pixi run secret-set <account>"); process.exit(2) }
const service = await GoogleService.open(pluginDataDir("oc-google", process.env.OC_GOOGLE_DATA_DIR || undefined))
const account = await service.store.get(id)
if (!account) { console.error(`No account ${id}. Create it first (pixi run signin ${id} --client-id …, or google_account_upsert).`); process.exit(1) }
if (!account.clientId) { console.error(`Set the client ID of ${id} first.`); process.exit(1) }
function readHidden(prompt) {
  if (!process.stdin.isTTY) return new Promise(resolve => { let data = ""; process.stdin.on("data", c => { data += c }); process.stdin.on("end", () => resolve(data.trim())) })
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = text => { if (!muted) process.stdout.write(text) }
    rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()) })
    muted = true
  })
}
const secret = await readHidden(`Client secret for ${id} (${account.clientId}): `)
if (!secret) { console.error("Empty; nothing stored."); process.exit(1) }
try { await service.setSecret(account, secret) } catch (error) { console.error(error.message); process.exit(1) }
console.log(`Stored. Next: pixi run signin ${id} (or google_signin, or Sign in in OpenCode's Google view).`)
service.dispose()
