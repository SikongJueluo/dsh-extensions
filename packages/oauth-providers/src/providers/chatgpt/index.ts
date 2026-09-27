/**
 * The ChatGPT provider module: everything one OAuth-authenticated vendor
 * contributes — its config schema, LLM route, model catalog, token store,
 * and sign-in flow.
 *
 * @module dsh-oauth-providers/providers/chatgpt
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
// Type-only import: pulls the `Context.settings` module augmentation in.
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { OpenAiOauthAdapter } from './adapter.js'
import { DEFAULT_REFRESH_MARGIN_MS, TokenStore } from './auth.js'
import { DEFAULT_REASONING_EFFORTS, ModelCatalog } from './catalog.js'
import { createDiscovery } from './discovery.js'
import { registerChatGptSignIn } from './login.js'
import { PACKAGE_NAME, PLUGIN_NAME } from '../../identity.js'
import { CREDENTIAL_ID, DISPLAY_NAME, PROVIDER, SETTINGS_NAMESPACE } from './identity.js'
import type { AuthChannel } from '../../channel.js'
import { createFetch } from '../../transport.js'
import type { FetchLike } from '../../transport.js'

export { PROVIDER, SETTINGS_NAMESPACE, CREDENTIAL_ID, DISPLAY_NAME } from './identity.js'

/** The credential record the sign-in flow writes and the adapter reads. */
// The credential scope is this plugin's registered name (the composition row id).
export const CREDENTIAL_KEY = credentialKey(PLUGIN_NAME, CREDENTIAL_ID)

/** ChatGPT codex backend base URL (Responses API). */
export const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const DEFAULT_CLIENT_VERSION = '0.146.0'
export const DEFAULT_CONTEXT_WINDOW = 272000

/** Reasoning effort vocabulary shared by the ChatGPT backend. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'off'] as const

/** One entry of {@link REASONING_EFFORTS}. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Config shape validated by the {@link ChatGptConfig} schema (row config and settings section). */
export interface ChatGptConfig {
  /** ChatGPT backend base URL for the Responses API. */
  baseURL?: string
  /** Client version sent to the /models endpoint. */
  clientVersion?: string
  /** Outbound proxy URL (empty = auto-detect). */
  proxyUrl?: string
  /** Reasoning effort applied when a request does not name one. */
  defaultReasoningEffort?: ReasoningEffort
  /** Refresh the OAuth grant when it is this close to expiry (ms). */
  refreshMarginMs?: number
  /** Fallback context window for models the backend does not describe. */
  defaultContextWindow?: number
}

/** Loose input snapshot accepted by `resolveAdapterOptions`. */
export interface ResolvedChatGptConfig {
  baseURL?: string
  clientVersion?: string
  proxyUrl?: string
  defaultReasoningEffort?: string
  refreshMarginMs?: number
  defaultContextWindow?: number
}

export const ChatGptConfig: Schema<ChatGptConfig> = Schema.object({
  baseURL: Schema.string().description('ChatGPT backend base URL for the Responses API.'),
  clientVersion: Schema.string().description('Client version sent to the /models endpoint.'),
  proxyUrl: Schema.string().description(
    'Outbound proxy URL (empty = auto-detect from env / macOS, Windows, or Linux system proxy).',
  ),
  defaultReasoningEffort: Schema.union([...REASONING_EFFORTS]).description(
    'Reasoning effort applied when a request does not name one.',
  ),
  refreshMarginMs: Schema.number().step(1).min(1).description(
    'Refresh the OAuth grant when it is this close to expiry (ms).',
  ),
  defaultContextWindow: Schema.number().step(1).min(1).description(
    'Fallback context window for models the backend does not describe.',
  ),
})

/** Fully-resolved connection facts (defaults applied and validated). */
export interface ResolvedOptions {
  baseURL: string
  clientVersion: string
  proxyUrl?: string
  defaultReasoningEffort: string
  refreshMarginMs: number
  defaultContextWindow: number
  defaultReasoningEfforts: string[]
}

/**
 * Resolve validated connection facts from a raw config snapshot. Every default
 * and bound is re-judged here so a settings edit fails loudly at first use.
 */
export function resolveAdapterOptions(config: ResolvedChatGptConfig = {}): ResolvedOptions {
  const defaultReasoningEffort = config.defaultReasoningEffort ?? 'high'
  const refreshMarginMs = config.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS
  if (!Number.isFinite(refreshMarginMs) || refreshMarginMs <= 0) {
    throw new Error(`${PACKAGE_NAME}/chatgpt: refreshMarginMs must be a positive number`)
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error(`${PACKAGE_NAME}/chatgpt: defaultContextWindow must be a positive integer`)
  }
  if (!(REASONING_EFFORTS as readonly string[]).includes(defaultReasoningEffort)) {
    throw new Error(`${PACKAGE_NAME}/chatgpt: unknown defaultReasoningEffort "${defaultReasoningEffort}"`)
  }
  return {
    baseURL: (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    clientVersion: config.clientVersion ?? DEFAULT_CLIENT_VERSION,
    proxyUrl: config.proxyUrl || undefined,
    defaultReasoningEffort,
    refreshMarginMs,
    defaultContextWindow,
    defaultReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
  }
}

export interface RegisterChatGptDeps {
  channel: AuthChannel
  /** Composition-entry base layer for the settings namespace. */
  base?: ResolvedChatGptConfig
}

/** Wire the ChatGPT provider: LLM route, catalog, token store, settings, sign-in. */
export function registerChatGpt(ctx: Context, { channel, base = {} }: RegisterChatGptDeps): void {
  const log = ctx.logger(`${PACKAGE_NAME}/chatgpt`)
  let current: () => ResolvedChatGptConfig = () => base
  let lastRaw: ResolvedChatGptConfig | undefined
  let lastGood: ResolvedOptions | undefined

  const options = (): ResolvedOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      log.error('keeping the last good configuration after an invalid settings section')
      log.error(error)
      return lastGood
    }
  }
  options()

  log.info('loaded (provider=%s, baseURL=%s)', PROVIDER, options().baseURL)

  // Proxy-aware fetch, resolved once on first use.
  let fetchPromise: Promise<FetchLike> | undefined
  const getFetch = (): Promise<FetchLike> => (fetchPromise ??= createFetch(options().proxyUrl))
  const fetchVia: FetchLike = async (url, init) => (await getFetch())(url, init)

  const tokenStore = new TokenStore({
    key: CREDENTIAL_KEY,
    credentials: ctx.credentials,
    fetch: fetchVia,
    logger: ctx.logger,
  })
  const catalog = new ModelCatalog({ fetch: fetchVia, options })
  const adapter = new OpenAiOauthAdapter({ options, tokenStore, catalog, getFetch })

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs: SETTINGS_NAMESPACE,
      settingsPath: [],
    },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerModelDiscovery(SETTINGS_NAMESPACE, createDiscovery({ options, tokenStore, catalog }))

  // The composition entry is the base layer; while the settings service holds
  // our namespace, its resolved scope replaces the entry as the live source.
  ctx.settings.installSection(ctx, SETTINGS_NAMESPACE, ChatGptConfig, base as ChatGptConfig, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      options()
    },
  })

  registerChatGptSignIn(ctx, { key: CREDENTIAL_KEY, fetch: fetchVia, channel })
}
