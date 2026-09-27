/**
 * OpenAI ChatGPT OAuth protocol (PKCE + loopback callback).
 *
 * Implements the same authorization flow the Codex CLI and pi-ai use against
 * `auth.openai.com`: a PKCE S256 authorization URL the human opens in a
 * browser, a loopback HTTP server on 127.0.0.1:1455 that catches the
 * redirect, and a manual paste fallback that accepts the whole redirect URL,
 * a `code#state` pair, or a bare authorization code when the loopback server
 * cannot be reached (remote host, occupied port).
 *
 * Adapted from pi-ai's `openai-codex` flow (MIT) and werifu/dsh-oai-oauth
 * (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai/oauth
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { PACKAGE_NAME } from '../../identity.js'
import type { FetchLike } from '../../transport.js'

/** The public OAuth client id the Codex CLI uses for the ChatGPT login. */
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** OpenAI authorization endpoint. */
export const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
/** OpenAI token endpoint (code exchange and refresh). */
export const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Loopback redirect URI registered for the client id (fixed port). */
export const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
/** Loopback port the callback server listens on. */
export const OAUTH_CALLBACK_PORT = 1455
/** Loopback host the callback server binds. */
export const OAUTH_CALLBACK_HOST = '127.0.0.1'
/** OAuth scopes for the ChatGPT login. */
export const OAUTH_SCOPE = 'openid profile email offline_access'
/** JWT claim path carrying the ChatGPT account id. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/** The stored OAuth grant: everything later requests and refreshes need. */
export interface OAuthGrant {
  access: string
  refresh: string
  /** Expiry in epoch milliseconds. */
  expires: number
  accountId: string
}

/** Base64url-encode bytes (no padding). */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Generate a PKCE S256 verifier/challenge pair. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(verifierBytes)
  const verifier = base64url(verifierBytes)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge: base64url(digest) }
}

/** Build the authorization URL plus the PKCE/state secrets it is bound to. */
export async function createAuthorizationRequest(originator: string = PACKAGE_NAME): Promise<{
  verifier: string
  state: string
  url: string
}> {
  const { verifier, challenge } = await generatePkce()
  const state = randomBytes(16).toString('hex')
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI)
  url.searchParams.set('scope', OAUTH_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', originator)
  return { verifier, state, url: url.toString() }
}

/**
 * Parse a pasted authorization answer: the whole redirect URL, a
 * `code#state` pair, `code=…` parameters, or a bare code.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // not a URL
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }
  return { code: value }
}

/** Decode a compact JWT payload without verifying the signature. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract the ChatGPT account id from an access token's claims. */
export function accountIdOf(accessToken: string): string | undefined {
  const auth = decodeJwtPayload(accessToken)?.[JWT_CLAIM_PATH] as
    | { chatgpt_account_id?: unknown }
    | undefined
  const accountId = auth?.chatgpt_account_id
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
}

/** Validate a token-endpoint response and map it into an {@link OAuthGrant}. */
export function grantFromTokenResponse(json: unknown): OAuthGrant {
  const body = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string' || typeof body?.expires_in !== 'number') {
    throw new Error(`OpenAI token response missing fields: ${JSON.stringify(json).slice(0, 200)}`)
  }
  const accountId = accountIdOf(body.access_token)
  if (!accountId) throw new Error('OpenAI token response carries no ChatGPT account id')
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
    accountId,
  }
}

/** POST the token endpoint with form-urlencoded parameters. */
async function tokenRequest(fetch: FetchLike, params: Record<string, string>, signal?: AbortSignal): Promise<OAuthGrant> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI token endpoint returned HTTP ${response.status}: ${text.slice(0, 200) || response.statusText}`)
  }
  return grantFromTokenResponse(await response.json())
}

/** Exchange an authorization code (with its PKCE verifier) for a grant. */
export function exchangeAuthorizationCode(
  fetch: FetchLike,
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<OAuthGrant> {
  return tokenRequest(fetch, {
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: OAUTH_REDIRECT_URI,
  }, signal)
}

/** Refresh a grant from its refresh token. */
export function refreshGrant(fetch: FetchLike, refreshToken: string, signal?: AbortSignal): Promise<OAuthGrant> {
  return tokenRequest(fetch, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }, signal)
}

/** The callback server's externally controlled handle. */
export interface CallbackServer {
  /** Resolve with the authorization code, or null when cancelled/closed. */
  waitForCode(): Promise<{ code: string } | null>
  /** Stop waiting for a code (the manual paste won the race). */
  cancelWait(): void
  /** Shut the server down. */
  close(): void
}

function successPage(): string {
  return '<!doctype html><meta charset="utf-8"><title>Signed in</title><p>OpenAI authentication completed. You can close this window and return to DSH.</p>'
}

function errorPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>${message}</p>`
}

/**
 * Listen on the loopback redirect port for the OAuth callback. Resolves with
 * a {@link CallbackServer} whose `waitForCode` fulfills on a state-matching
 * code; resolves with a no-op server when the port cannot be bound (remote
 * host or another login holding it) so the paste fallback takes over.
 */
export function startCallbackServer(state: string): Promise<CallbackServer> {
  let settleWait: ((value: { code: string } | null) => void) | undefined
  const waitForCode = new Promise<{ code: string } | null>((resolve) => {
    settleWait = (value) => resolve(value)
  })
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(errorPage('Callback route not found.'))
        return
      }
      if (url.searchParams.get('state') !== state) {
        res.statusCode = 400
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(errorPage('State mismatch.'))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.statusCode = 400
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(errorPage('Missing authorization code.'))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(successPage())
      settleWait?.({ code })
      settleWait = undefined
      server.close()
    } catch {
      res.statusCode = 500
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(errorPage('Internal error while processing the OAuth callback.'))
    }
  })
  return new Promise((resolve) => {
    const settleAndClose = () => {
      settleWait?.(null)
      settleWait = undefined
      server.close()
    }
    server
      .listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
        resolve({
          waitForCode: () => waitForCode,
          cancelWait: () => {
            settleWait?.(null)
            settleWait = undefined
          },
          close: settleAndClose,
        })
      })
      .once('error', () => {
        // Port unavailable (another login holds it, or a headless remote
        // host): hand back a no-op server so the manual paste path serves
        // the login instead.
        settleWait?.(null)
        settleWait = undefined
        resolve({
          waitForCode: async () => null,
          cancelWait: () => undefined,
          close: () => {
            try {
              server.close()
            } catch {
              // never listened; nothing to close
            }
          },
        })
      })
  })
}
