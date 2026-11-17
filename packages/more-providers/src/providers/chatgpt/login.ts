/**
 * ChatGPT sign-in: the authorization flow on the harness seam.
 * @module dsh-more-providers/providers/chatgpt/login
 */
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthChannel } from '../../oauth/channel.js'
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  OAUTH_REDIRECT_URI,
  parseAuthorizationInput,
  startCallbackServer,
} from './oauth.js'
import type { OAuthGrant } from './oauth.js'
import type { FetchLike } from '../../oauth/transport.js'
import { DISPLAY_NAME, PROVIDER } from './identity.js'
import { PACKAGE_NAME } from '../../identity.js'

export interface ChatGptSignInDeps {
  key: CredentialKey
  fetch: FetchLike
  channel: AuthChannel
  settingsNs: string
  logger: Logger
}

/** Parse and state-check a pasted authorization answer. */
function codeOf(input: string, state: string): string | undefined {
  const parsed = parseAuthorizationInput(input)
  if (parsed.state !== undefined && parsed.state !== state)
    throw new Error('Authorization state mismatch')
  return parsed.code
}

/** Wrap an OAuth grant as the credential record this package stores. */
function grantRecord(grant: OAuthGrant): { kind: 'grant'; payload: OAuthGrant } {
  return { kind: 'grant', payload: { ...grant } }
}

/** Register the ChatGPT authorization flow and declare the provider on the shared browser sign-in channel. */
export function registerChatGptSignIn(
  ctx: Context,
  { key, fetch, channel, settingsNs, logger }: ChatGptSignInDeps,
): void {
  channel.register({ id: PROVIDER, label: DISPLAY_NAME, settingsNs, key })

  ctx.inject(['authorization'], (authCtx) => {
    authCtx.authorization.registerFlow({
      key,
      label: 'OpenAI ChatGPT',
      methods: [{ id: 'browser', label: 'Sign in with ChatGPT (browser)' }],
      async run(session) {
        const { verifier, state, url } = await createAuthorizationRequest(PACKAGE_NAME)
        const server = await startCallbackServer(state, logger)
        const manualAbort = new AbortController()
        const onAbort = () => server.cancelWait()
        session.signal.addEventListener('abort', onAbort, { once: true })
        if (session.signal.aborted) onAbort()
        try {
          session.notify({
            message:
              'Sign in with your ChatGPT account in the browser. If no window opens, use this link.',
            url,
          })
          let manual: { input?: string; error?: Error } | undefined
          const manualPromise = session
            .prompt({
              kind: 'text',
              message:
                'If the browser cannot redirect back to this machine, paste the redirected URL or the authorization code here.',
              placeholder: OAUTH_REDIRECT_URI,
              signal: manualAbort.signal,
            })
            .then((input) => {
              manual = { input }
              server.cancelWait()
              return undefined
            })
            .catch((error: unknown) => {
              manual = { error: error instanceof Error ? error : new Error(String(error)) }
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
            await manualPromise
            if (manual?.error) throw manual.error
            if (manual?.input !== undefined) code = codeOf(manual.input, state)
          }
          if (!code) throw new Error('Missing authorization code')

          const grant = await exchangeAuthorizationCode(fetch, code, verifier, session.signal)
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
