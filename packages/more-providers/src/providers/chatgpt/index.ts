/**
 * ChatGPT route, model catalog and sign-in over a validated startup snapshot. OAuth grants retain their pre-merge credential address.
 * @module dsh-more-providers/providers/chatgpt
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { OpenAiOauthAdapter } from './adapter.js'
import { DEFAULT_REFRESH_MARGIN_MS, TokenStore } from './auth.js'
import { DEFAULT_REASONING_EFFORTS, ModelCatalog } from './catalog.js'
import type { CatalogStats } from './catalog.js'
import { createDiscovery } from './discovery.js'
import { registerChatGptSignIn } from './login.js'
import type { AuthChannel } from '../../oauth/channel.js'
import type { OAuthProvidersService } from '../../oauth/service.js'
import { createFetch } from '../../oauth/transport.js'
import type { FetchLike } from '../../oauth/transport.js'
import { OAUTH_CREDENTIAL_SCOPE, PACKAGE_NAME } from '../../identity.js'
import { isRecord } from '../../record.js'
import type { ProviderImageServices } from '../../runtime.js'
import type { ModelFilter } from '../../catalog/filter.js'
import { CREDENTIAL_ID, PROVIDER, SETTINGS_NAMESPACE } from './identity.js'

const CREDENTIAL_KEY = credentialKey(OAUTH_CREDENTIAL_SCOPE, CREDENTIAL_ID)

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_CONTEXT_WINDOW = 272000

export interface ChatGptConfig {
  baseURL?: string
  clientVersion?: string
  refreshMarginMs?: number
  defaultContextWindow?: number
  promptCacheKey?: boolean
  filter?: ModelFilter
}

export type ResolvedChatGptConfig = ChatGptConfig

/** Fully-resolved connection facts (defaults applied and validated). */
interface ResolvedOptions {
  displayName: string
  baseURL: string
  clientVersion?: string
  refreshMarginMs: number
  defaultContextWindow: number
  defaultReasoningEffort: string
  defaultReasoningEfforts: string[]
  promptCacheKey: boolean
}

/** Apply connection defaults to the root loader's validated startup snapshot. */
function resolveAdapterOptions(
  config: ResolvedChatGptConfig,
  displayName: string,
): ResolvedOptions {
  return {
    displayName,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    clientVersion: config.clientVersion === '' ? undefined : config.clientVersion,
    refreshMarginMs: config.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultReasoningEffort: 'high',
    defaultReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
    promptCacheKey: config.promptCacheKey ?? true,
  }
}

export interface RegisterChatGptDeps {
  channel: AuthChannel
  displayName: string
  config: ResolvedChatGptConfig
  tokens: OAuthProvidersService
  images: ProviderImageServices
}

/** Read-only ChatGPT route facts for the providers snapshot. */
export interface ChatGptStatus {
  registered: boolean
  models?: CatalogStats
  catalogError?: string
}

/** Reads the live ChatGPT status; returned by {@link registerChatGpt}. */
export type ChatGptStatusView = () => ChatGptStatus

/** Build the read-only status view over one catalog; `registered` is true by construction. */
export function chatGptStatus(catalog: ModelCatalog): ChatGptStatusView {
  return () => {
    const models = catalog.stats()
    const catalogError = catalog.error()
    return {
      registered: true,
      ...(models === undefined ? {} : { models }),
      ...(catalogError === undefined ? {} : { catalogError }),
    }
  }
}

/** One mounted ChatGPT generation: the live status view plus the disposer a reload needs. */
export interface ChatGptRegistration {
  readonly view: ChatGptStatusView
  dispose(): void
}

/** Wire the ChatGPT provider: LLM route, catalog, token store, sign-in. */
export function registerChatGpt(
  ctx: Context,
  { channel, displayName, tokens, config, images }: RegisterChatGptDeps,
): ChatGptRegistration {
  const log = ctx.logger(`${PACKAGE_NAME}/chatgpt`)
  const options = resolveAdapterOptions(config, displayName)
  log.info('loaded (provider=%s, baseURL=%s)', PROVIDER, options.baseURL)

  let fetchPromise: Promise<FetchLike> | undefined
  const getFetch = (): Promise<FetchLike> => (fetchPromise ??= createFetch())
  const fetchVia: FetchLike = async (url, init) => (await getFetch())(url, init)

  const tokenStore = new TokenStore({
    key: CREDENTIAL_KEY,
    credentials: ctx.credentials,
    fetch: fetchVia,
    logger: ctx.logger,
  })
  tokens.register(PROVIDER, () => tokenStore.resolve())
  const catalog = new ModelCatalog({
    fetch: fetchVia,
    options,
    logger: log,
    ...(config.filter === undefined ? {} : { filter: config.filter }),
  })
  const adapter = new OpenAiOauthAdapter({
    options,
    tokenStore,
    catalog,
    getFetch,
    images,
    logger: log,
  })

  const fiber: unknown = ctx.fiber
  const entryId =
    isRecord(fiber) &&
    isRecord(fiber.entry) &&
    isRecord(fiber.entry.options) &&
    typeof fiber.entry.options.id === 'string'
      ? fiber.entry.options.id
      : undefined
  const settingsNs = entryId ?? SETTINGS_NAMESPACE
  const disposeAdapter = ctx.llm.registerAdapter([PROVIDER], adapter)
  const disposeDiscovery = ctx.llm.registerModelDiscovery(
    settingsNs,
    createDiscovery({ refreshMarginMs: options.refreshMarginMs, tokenStore, catalog }),
  )
  const disposeSignIn = registerChatGptSignIn(ctx, {
    key: CREDENTIAL_KEY,
    fetch: fetchVia,
    channel,
    settingsNs,
    logger: log,
  })

  return {
    view: chatGptStatus(catalog),
    dispose: () => {
      disposeSignIn()
      disposeDiscovery()
      disposeAdapter()
    },
  }
}
