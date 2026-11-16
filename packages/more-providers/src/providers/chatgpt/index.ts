/**
 * ChatGPT route, model catalog and sign-in over a validated startup snapshot.
 * OAuth grants retain their pre-merge credential address.
 * @module dsh-more-providers/providers/chatgpt
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { OpenAiOauthAdapter } from './adapter.js'
import { DEFAULT_REFRESH_MARGIN_MS, TokenStore } from './auth.js'
import { DEFAULT_REASONING_EFFORTS, ModelCatalog } from './catalog.js'
import { createDiscovery } from './discovery.js'
import { registerChatGptSignIn } from './login.js'
import type { AuthChannel } from '../../oauth/channel.js'
import type { OAuthProvidersService } from '../../oauth/service.js'
import { createFetch } from '../../oauth/transport.js'
import type { FetchLike } from '../../oauth/transport.js'
import { OAUTH_CREDENTIAL_SCOPE, PACKAGE_NAME } from '../../identity.js'
import { isRecord } from '../../record.js'
import type { ProviderImageServices } from '../../runtime.js'
import { CREDENTIAL_ID, PROVIDER, SETTINGS_NAMESPACE } from './identity.js'

/**
 * The credential record the sign-in flow writes and the adapter reads. The
 * scope is the fixed pre-merge OAuth scope, so existing grants keep working.
 */
const CREDENTIAL_KEY = credentialKey(OAUTH_CREDENTIAL_SCOPE, CREDENTIAL_ID)

/** ChatGPT codex backend base URL (Responses API). */
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_CONTEXT_WINDOW = 272000

/**
 * ChatGPT connection settings: the five YAML fields under
 * `providers.chatgpt` (root config validates them strictly; restart to
 * change). Outbound networking rides the process network with standard proxy
 * auto-detection, and the default reasoning effort is fixed — per-request
 * effort stays selectable in the model picker.
 */
export interface ChatGptConfig {
  /** ChatGPT backend base URL for the Responses API. */
  baseURL?: string
  /** Client version reported to the backend; absent = latest from npm. */
  clientVersion?: string
  /** Refresh the OAuth grant when it is this close to expiry (ms). */
  refreshMarginMs?: number
  /** Fallback context window for models the backend does not describe. */
  defaultContextWindow?: number
  /** Stamp `prompt_cache_key` + session-affinity headers (measured 16–21% → high cache hits). */
  promptCacheKey?: boolean
}

export type ResolvedChatGptConfig = ChatGptConfig

/** Fully-resolved connection facts (defaults applied and validated). */
interface ResolvedOptions {
  baseURL: string
  /** Explicit client-version override; undefined = derive from npm. */
  clientVersion?: string
  refreshMarginMs: number
  defaultContextWindow: number
  defaultReasoningEffort: string
  defaultReasoningEfforts: string[]
  promptCacheKey: boolean
}

/** Apply connection defaults to the root loader's validated startup snapshot. */
function resolveAdapterOptions(config: ResolvedChatGptConfig): ResolvedOptions {
  return {
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
  /** Immutable configuration validated before any route is registered. */
  config: ResolvedChatGptConfig
  /** Shared OAuth token service this module registers its resolver into. */
  tokens: OAuthProvidersService
  /** Host image services shared with every adapter in this plugin. */
  images: ProviderImageServices
}

/** Wire the ChatGPT provider: LLM route, catalog, token store, sign-in. */
export function registerChatGpt(
  ctx: Context,
  { channel, tokens, config, images }: RegisterChatGptDeps,
): void {
  const log = ctx.logger(`${PACKAGE_NAME}/chatgpt`)
  const options = resolveAdapterOptions(config)
  log.info('loaded (provider=%s, baseURL=%s)', PROVIDER, options.baseURL)

  // Proxy-aware fetch, resolved once on first use: standard environment /
  // system-proxy detection applies on the first outbound request.
  let fetchPromise: Promise<FetchLike> | undefined
  const getFetch = (): Promise<FetchLike> => (fetchPromise ??= createFetch())
  const fetchVia: FetchLike = async (url, init) => (await getFetch())(url, init)

  const tokenStore = new TokenStore({
    key: CREDENTIAL_KEY,
    credentials: ctx.credentials,
    fetch: fetchVia,
    logger: ctx.logger,
  })
  // Hand out fresh (refresh-rotated) tokens to host consumers that call the
  // ChatGPT backend directly — quota monitors today.
  tokens.register(PROVIDER, () => tokenStore.resolve())
  const catalog = new ModelCatalog({ fetch: fetchVia, options })
  const adapter = new OpenAiOauthAdapter({ options, tokenStore, catalog, getFetch, images })

  // 0.2 settings model: the settings namespace IS this plugin's profile entry
  // id. `fiber.entry` is attached at runtime by cordis-plugin-loader (untyped
  // in cordis 4.0.4's Fiber declaration); fall back to the stock row id.
  const fiber: unknown = ctx.fiber
  const entryId =
    isRecord(fiber) &&
    isRecord(fiber.entry) &&
    isRecord(fiber.entry.options) &&
    typeof fiber.entry.options.id === 'string'
      ? fiber.entry.options.id
      : undefined
  const settingsNs = entryId ?? SETTINGS_NAMESPACE
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerModelDiscovery(
    settingsNs,
    createDiscovery({ refreshMarginMs: options.refreshMarginMs, tokenStore, catalog }),
  )

  registerChatGptSignIn(ctx, { key: CREDENTIAL_KEY, fetch: fetchVia, channel, settingsNs })
}
