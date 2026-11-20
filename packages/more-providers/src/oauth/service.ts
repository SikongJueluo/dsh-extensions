/**
 * The `oauthProviders` host service: a per-provider OAuth token window for host consumers that need to call the vendor's own backend APIs with the signed-in account - quota monitors (dsh-plan-usage's OpenAI usage source) being the first.
 * @module dsh-more-providers/oauth/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PACKAGE_NAME } from '../identity.js'

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

  /** Drop one provider's resolver; idempotent, so a reload can mount and unmount freely. */
  unregister(provider: string): void {
    this.resolvers.delete(provider)
  }

  /** Every provider that can hand out a token right now. */
  providers(): string[] {
    return [...this.resolvers.keys()]
  }

  /** One provider's usable token, or `undefined` when the provider is unknown, not signed in, or its refresh failed (warn-logged). Never throws. */
  async token(provider: string): Promise<OAuthToken | undefined> {
    const resolve = this.resolvers.get(provider)
    if (resolve === undefined) return undefined
    try {
      return await resolve()
    } catch (error) {
      this.ctx
        .logger(PACKAGE_NAME)
        .warn?.(
          'token for "%s" unavailable: %s',
          provider,
          error instanceof Error ? error.message : String(error),
        )
      return undefined
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oauthProviders: OAuthProvidersService
  }
}
