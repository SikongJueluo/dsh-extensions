/**
 * ChatGPT OAuth grant store over the harness credential seam.
 *
 * The sign-in flow commits an {@link OAuthGrant} into the credential record
 * `openai/chatgpt`; this store hands out usable access tokens and refreshes
 * the grant when it is close to expiry. Rotation happens inside
 * `credentials.modifyRecord`, whose exclusive write window serializes
 * concurrent refreshes across processes, so two racing readers never burn the
 * rotating refresh token.
 *
 * Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai/auth
 */
import type { LoggerService } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { refreshGrant } from './oauth.js'
import type { OAuthGrant } from './oauth.js'
import type { FetchLike } from '../../transport.js'

/** Refresh once the access token is this close to expiry (default 24h). */
export const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000

/** The credential-seam surface the store needs (satisfied by `ctx.credentials`). */
export interface CredentialStoreLike {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
}

/** A usable OAuth credential pair. */
export interface ResolvedToken {
  access: string
  accountId?: string
}

/** Auth headers for ChatGPT backend-api calls authenticated with the OAuth token. */
export function oauthHeaders(access: string, accountId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    'oai-product-sku': 'codex',
  }
}

/** Stable classes for auth failures, so callers can branch without parsing messages. */
export type AuthErrorCode = 'AUTH_MISSING' | 'AUTH_INVALID' | 'AUTH_REFRESH_FAILED'

/** An auth failure with a routable code (no sign-in vs. refresh failure). */
export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthError'
    this.code = code
  }
}

/** Parse a grant record's payload, or report why it is not usable. */
function parseGrant(record: CredentialRecord | undefined): OAuthGrant {
  if (record === undefined) {
    throw new AuthError('AUTH_MISSING', 'oauth-providers/chatgpt: no sign-in stored — open Settings → OAuth Providers and click "Sign in"')
  }
  if (record.kind !== 'grant') {
    throw new AuthError('AUTH_INVALID', `oauth-providers/chatgpt: credential record has kind "${record.kind}", expected "grant"`)
  }
  const payload = record.payload as Partial<OAuthGrant> | null
  if (
    typeof payload?.access !== 'string' || payload.access.length === 0 ||
    typeof payload?.refresh !== 'string' || payload.refresh.length === 0 ||
    typeof payload?.expires !== 'number' || !Number.isFinite(payload.expires)
  ) {
    throw new AuthError('AUTH_INVALID', 'oauth-providers/chatgpt: stored sign-in is malformed — sign in again')
  }
  return {
    access: payload.access,
    refresh: payload.refresh,
    expires: payload.expires,
    accountId: typeof payload.accountId === 'string' ? payload.accountId : '',
  }
}

const grantRecord = (grant: OAuthGrant): CredentialRecord => ({
  kind: 'grant',
  payload: { ...grant },
})

export interface TokenStoreOptions {
  key: CredentialKey
  credentials: CredentialStoreLike
  fetch: FetchLike
  logger?: LoggerService
}

export class TokenStore {
  private readonly key: CredentialKey
  private readonly credentials: CredentialStoreLike
  private readonly fetch: FetchLike
  private readonly logger?: LoggerService
  private refreshing: Promise<ResolvedToken> | null = null

  constructor({ key, credentials, fetch, logger }: TokenStoreOptions) {
    this.key = key
    this.credentials = credentials
    this.fetch = fetch
    this.logger = logger
  }

  /**
   * Return a usable `{ access, accountId }` pair, refreshing the grant when
   * the access token is expired or within the refresh margin. Concurrent
   * callers share one refresh; concurrent processes serialize inside
   * `modifyRecord`'s exclusive write window.
   */
  async resolve(marginMs: number = DEFAULT_REFRESH_MARGIN_MS): Promise<ResolvedToken> {
    const grant = parseGrant(await this.credentials.readRecord(this.key))
    const needsRefresh = grant.expires <= Date.now() + marginMs
    if (!needsRefresh) return { access: grant.access, ...(grant.accountId ? { accountId: grant.accountId } : {}) }
    this.refreshing ??= this.refresh(grant, marginMs).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** Refresh under the record's exclusive write window and return the live token. */
  private async refresh(stale: OAuthGrant, marginMs: number): Promise<ResolvedToken> {
    try {
      const updated = await this.credentials.modifyRecord(this.key, async (current) => {
        // Another process may have rotated the grant between our read and
        // this exclusive window; a still-fresh record means their token wins.
        const asSeen = parseGrant(current)
        if (asSeen.expires > Date.now() + marginMs) return undefined
        const next = await refreshGrant(this.fetch, asSeen.refresh)
        this.logger?.debug?.('oauth-providers/chatgpt: refreshed OAuth grant (expires %s)', new Date(next.expires).toISOString())
        return grantRecord(next)
      })
      const grant = parseGrant(updated ?? (await this.credentials.readRecord(this.key)))
      return { access: grant.access, ...(grant.accountId ? { accountId: grant.accountId } : {}) }
    } catch (error) {
      if (error instanceof AuthError) throw error
      throw new AuthError(
        'AUTH_REFRESH_FAILED',
        `oauth-providers/chatgpt: token refresh failed (${(error as Error).message}) — sign in again`,
        { cause: error },
      )
    }
  }
}
