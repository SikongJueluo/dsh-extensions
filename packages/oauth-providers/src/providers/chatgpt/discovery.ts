/**
 * Model discovery for the web Models page.
 *
 * Registered through `ctx.llm.registerModelDiscovery()` so the settings
 * surface gets a "fetch/discover models" action. The handler is a manual
 * refresh (it always re-hits the backend, bypassing the catalog cache) and an
 * implicit sign-in probe: a missing sign-in surfaces the AuthError that tells
 * the user to open Settings → OpenAI.
 *
 * Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai/discovery
 */
import { oauthHeaders } from './auth.js'
import type { TokenStore } from './auth.js'
import type { ModelCatalog } from './catalog.js'

/** Wire view the discovery handler returns (mirrors the host contract). */
export interface DiscoveredModelView {
  id: string
  name?: string
  contextWindow?: number
}

export interface DiscoveryDeps {
  options: () => {
    refreshMarginMs: number
  }
  tokenStore: TokenStore
  catalog: ModelCatalog
}

/** Build the `registerModelDiscovery` handler for the `openai` namespace. */
export function createDiscovery({ options, tokenStore, catalog }: DiscoveryDeps) {
  return async function discover(): Promise<DiscoveredModelView[]> {
    // Probe the stored sign-in first (refreshing when near expiry) so a
    // missing or expired login surfaces as the provider's failure reason.
    const token = await tokenStore.resolve(options().refreshMarginMs)
    const models = await catalog.forceRefresh(oauthHeaders(token.access, token.accountId))
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    }))
  }
}
