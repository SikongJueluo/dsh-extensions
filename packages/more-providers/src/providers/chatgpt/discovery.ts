/**
 * Model discovery for the web Models page.
 * @module dsh-more-providers/providers/chatgpt/discovery
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
  refreshMarginMs: number
  tokenStore: TokenStore
  catalog: ModelCatalog
}

/** Build the `registerModelDiscovery` handler for the `openai` namespace. */
export function createDiscovery({ refreshMarginMs, tokenStore, catalog }: DiscoveryDeps) {
  return async function discover(): Promise<DiscoveredModelView[]> {
    const token = await tokenStore.resolve(refreshMarginMs)
    const models = await catalog.forceRefresh(oauthHeaders(token.access, token.accountId))
    return models.map((model) => {
      const view: DiscoveredModelView = { id: model.id, name: model.name }
      if (model.contextWindow !== undefined) view.contextWindow = model.contextWindow
      return view
    })
  }
}
