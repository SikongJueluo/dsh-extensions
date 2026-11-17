/**
 * Type-only shims for services this package consumes optionally.
 * @module dsh-plan-usage/shims
 */

/** Minimal `ctx.oauthProviders` surface consumed by the OpenAI source. */
export interface OAuthProvidersShim {
  token(provider: string): Promise<{ access: string; accountId?: string } | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oauthProviders?: OAuthProvidersShim
  }
}

/** Minimal `ctx.providerKeys` surface provided by dsh-more-providers. */
export interface ProviderKeysShim {
  key(provider: string): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    providerKeys?: ProviderKeysShim
  }
}
