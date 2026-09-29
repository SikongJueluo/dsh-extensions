/**
 * Type-only shims for services this package consumes optionally.
 *
 * `oauthProviders` is provided by the separate dsh-oauth-providers package;
 * when that plugin is absent the service reads as `undefined` and the OpenAI
 * usage source resolves no snapshots. The structural type below mirrors
 * dsh-oauth-providers' exported service surface.
 *
 * @module dsh-plan-usage/shims
 */

/** Minimal `ctx.oauthProviders` surface consumed by the OpenAI source. */
export interface OAuthProvidersShim {
  token(provider: string): Promise<{ access: string; accountId?: string } | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present when the dsh-oauth-providers plugin is mounted. */
    oauthProviders?: OAuthProvidersShim
  }
}
