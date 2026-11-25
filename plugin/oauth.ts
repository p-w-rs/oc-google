import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

/** Google OAuth 2.0 for installed apps (Desktop app client): authorization code + PKCE with a loopback redirect, refresh, revoke. */

export interface Grant {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
  readonly scopes: string[]
}

export class SignInError extends Error {
  constructor(readonly code: string | undefined, readonly description: string | undefined) { super(description ?? code ?? "sign-in failed") }
}

export interface Endpoint {
  readonly authUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
  readonly clientId: string
  readonly clientSecret: string
}

async function token(endpoint: Endpoint, params: Record<string, string>): Promise<Grant> {
  const response = await fetch(endpoint.tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: endpoint.clientId, client_secret: endpoint.clientSecret, ...params }),
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!data.access_token) throw new SignInError(String(data.error ?? response.status), typeof data.error_description === "string" ? data.error_description : undefined)
  return {
    accessToken: String(data.access_token), ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [],
  }
}

/** Google may not return a new refresh token on refresh; callers keep the old one then. */
export const refreshGrant = (endpoint: Endpoint, refreshToken: string) => token(endpoint, { grant_type: "refresh_token", refresh_token: refreshToken })

/** Best effort: revokes a refresh or access token (revoking either ends the whole grant). */
export async function revoke(endpoint: Endpoint, value: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint.revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: value }), signal: AbortSignal.timeout(10_000) })
    return response.ok
  } catch { return false }
}

const b64 = (buffer: Buffer) => buffer.toString("base64url")
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

export interface PendingSignIn {
  /** Open this in the browser on the OpenCode computer. */
  readonly url: string
  readonly expiresAt: number
  readonly done: Promise<Grant>
  cancel(): void
}

/** Starts a browser sign-in with a loopback redirect http://127.0.0.1:<random port> (Google's recommendation for desktop apps). */
export async function startBrowser(endpoint: Endpoint, scopes: readonly string[], options: { loginHint?: string; timeoutMs?: number } = {}): Promise<PendingSignIn> {
  let settle!: (value: URLSearchParams) => void, fail!: (error: Error) => void
  const result = new Promise<URLSearchParams>((resolve, reject) => { settle = resolve; fail = reject })
  const verifier = b64(randomBytes(48)), state = b64(randomBytes(16))
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/" || url.searchParams.get("state") !== state) { res.writeHead(404); res.end(); return }
    const ok = !!url.searchParams.get("code")
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<!doctype html><title>Google sign-in</title><body style="font:16px system-ui;margin:3em">${ok ? "<h2>Signed in to Google.</h2><p>You can close this tab and return to OpenCode.</p>" : `<h2>Sign-in did not complete.</h2><p>${escapeHtml(url.searchParams.get("error") ?? "")}</p><p>Return to OpenCode for details.</p>`}</body>`)
    settle(url.searchParams)
  }
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const url = new URL(endpoint.authUrl)
  for (const [key, value] of Object.entries({
    client_id: endpoint.clientId, response_type: "code", redirect_uri: redirect, scope: scopes.join(" "), state,
    code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    access_type: "offline", prompt: "consent",
    ...(options.loginHint && { login_hint: options.loginHint }),
  })) url.searchParams.set(key, value)
  const timeoutMs = options.timeoutMs ?? 15 * 60_000
  const timer = setTimeout(() => fail(new SignInError("timeout", "The sign-in was not finished in time; start it again.")), timeoutMs)
  const done = result.then(params => {
    const code = params.get("code")
    if (!code) throw new SignInError(params.get("error") ?? undefined, params.get("error_description") ?? undefined)
    return token(endpoint, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier })
  }).finally(() => { clearTimeout(timer); server.close(); server.closeAllConnections?.() })
  done.catch(() => {})
  return { url: url.href, expiresAt: Date.now() + timeoutMs, done, cancel: () => fail(new SignInError("cancelled", "Sign-in cancelled")) }
}
