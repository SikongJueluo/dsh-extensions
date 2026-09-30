/**
 * ChatGPT sign-in: the authorization flow on the harness seam.
 *
 * The flow speaks the OAuth protocol from `./oauth.js` (PKCE + loopback
 * callback + manual paste fallback, following pi-ai's `openai-codex` flow)
 * and commits its grant into the credential record this package owns. Any
 * surface that can host an authorization conversation — the shared browser
 * channel in this package, or a future standard surface — may run it.
 *
 * @module dsh-oauth-providers/providers/chatgpt/login
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthChannel } from '../../channel.js'
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  OAUTH_REDIRECT_URI,
  parseAuthorizationInput,
  startCallbackServer,
} from './oauth.js'
import type { OAuthGrant } from './oauth.js'
import type { FetchLike } from '../../transport.js'
import { CREDENTIAL_ID, DISPLAY_NAME, PROVIDER } from './identity.js'
import { PACKAGE_NAME } from '../../identity.js'

export interface ChatGptSignInDeps {
  key: CredentialKey
  fetch: FetchLike
  channel: AuthChannel
  /** Settings namespace (the plugin row's entry id) this provider is edited under. */
  settingsNs: string
}

/** Parse and state-check a pasted authorization answer. */
function codeOf(input: string, state: string): string | undefined {
  const parsed = parseAuthorizationInput(input)
  if (parsed.state !== undefined && parsed.state !== state) throw new Error('Authorization state mismatch')
  return parsed.code
}

/** Wrap an OAuth grant as the credential record this package stores. */
function grantRecord(grant: OAuthGrant): { kind: 'grant'; payload: OAuthGrant } {
  return { kind: 'grant', payload: { ...grant } }
}

/**
 * Register the ChatGPT authorization flow and declare the provider on the
 * shared browser sign-in channel.
 */
export function registerChatGptSignIn(ctx: Context, { key, fetch, channel, settingsNs }: ChatGptSignInDeps): void {
  // Registry entry first: `providers`/`status` answer with or without the seam.
  channel.register({ id: PROVIDER, label: DISPLAY_NAME, settingsNs, key })

  ctx.inject(['authorization'], (authCtx) => {
    authCtx.authorization.registerFlow({
      key,
      label: 'OpenAI ChatGPT',
      methods: [{ id: 'browser', label: 'Sign in with ChatGPT (browser)' }],
      async run(session) {
        const { verifier, state, url } = await createAuthorizationRequest(PACKAGE_NAME)
        const server = await startCallbackServer(state)
        const manualAbort = new AbortController()
        const onAbort = () => server.cancelWait()
        session.signal.addEventListener('abort', onAbort, { once: true })
        if (session.signal.aborted) onAbort()
        try {
          session.notify({
            message: 'Sign in with your ChatGPT account in the browser. If no window opens, use this link.',
            url,
          })
          let manual: { input?: string; error?: Error } | undefined
          const manualPromise = session
            .prompt({
              kind: 'text',
              message: 'If the browser cannot redirect back to this machine, paste the redirected URL or the authorization code here.',
              placeholder: OAUTH_REDIRECT_URI,
              signal: manualAbort.signal,
            })
            .then((input) => {
              manual = { input }
              server.cancelWait()
            })
            .catch((error: Error) => {
              manual = { error }
              server.cancelWait()
            })

          let code: string | undefined
          const result = await server.waitForCode()
          if (manual?.error) throw manual.error
          if (result?.code) {
            code = result.code
          } else if (manual?.input !== undefined) {
            code = codeOf(manual.input, state)
          }
          if (!code) {
            // The callback never arrived; wait for the human's paste.
            await manualPromise
            if (manual?.error) throw manual.error
            if (manual?.input !== undefined) code = codeOf(manual.input, state)
          }
          if (!code) throw new Error('Missing authorization code')

          const grant = await exchangeAuthorizationCode(fetch, code, verifier, session.signal)
          // The commit the seam confirms: run() resolving means this record is stored.
          await authCtx.credentials.modifyRecord(key, async () => grantRecord(grant))
        } finally {
          session.signal.removeEventListener('abort', onAbort)
          manualAbort.abort()
          server.close()
        }
      },
    })
  })
}
