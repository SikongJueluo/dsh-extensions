/**
 * The `oauthProviders` host service: a per-provider OAuth token window for
 * host consumers that need to call the vendor's own backend APIs with the
 * signed-in account — quota monitors (dsh-plan-usage's OpenAI usage source)
 * being the first.
 *
 * Each provider module registers a resolver that goes through its own
 * TokenStore, so tokens handed out here are always the fresh, refresh-rotated
 * ones — never a stale copy read straight from the credential record.
 *
 * @module dsh-oauth-providers/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PACKAGE_NAME } from './identity.js'

/** A usable OAuth credential pair for one provider. */
export interface OAuthToken {
  access: string
  accountId?: string
}

/** Resolver a provider module registers; should refresh near-expiry tokens. */
export type TokenResolver = () => Promise<OAuthToken>

export class OAuthProvidersService extends Service {
  private readonly resolvers = new Map<string, TokenResolver>()

  constructor(ctx: Context) {
    super(ctx, 'oauthProviders')
  }

  /** Declare one provider's token resolver; idempotent per id. */
  register(provider: string, resolve: TokenResolver): void {
    this.resolvers.set(provider, resolve)
  }

  /** Every provider that can hand out a token right now. */
  providers(): string[] {
    return [...this.resolvers.keys()]
  }

  /**
   * One provider's usable token, or `undefined` when the provider is unknown,
   * not signed in, or its refresh failed (warn-logged). Never throws.
   */
  async token(provider: string): Promise<OAuthToken | undefined> {
    const resolve = this.resolvers.get(provider)
    if (resolve === undefined) return undefined
    try {
      return await resolve()
    } catch (error) {
      this.ctx.logger(PACKAGE_NAME).warn?.('token for "%s" unavailable: %s', provider, (error as Error).message)
      return undefined
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by dsh-oauth-providers; absent when that plugin is not mounted. */
    oauthProviders: OAuthProvidersService
  }
}
