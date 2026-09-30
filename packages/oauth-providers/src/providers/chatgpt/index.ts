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
import type { OAuthProvidersService } from '../../service.js'
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
export const DEFAULT_CONTEXT_WINDOW = 272000

/** Reasoning effort vocabulary shared by the ChatGPT backend (selectable per request). */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'off'] as const

/**
 * Config shape validated by the {@link ChatGptConfig} schema (row config and
 * settings section). Deliberately minimal: outbound networking rides the
 * process network with standard proxy auto-detection, and the default
 * reasoning effort is fixed — per-request effort stays selectable in the
 * model picker.
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
}

/** Loose input snapshot accepted by `resolveAdapterOptions`. */
export interface ResolvedChatGptConfig {
  baseURL?: string
  clientVersion?: string
  refreshMarginMs?: number
  defaultContextWindow?: number
}

export const ChatGptConfig: Schema<ChatGptConfig> = Schema.object({
  baseURL: Schema.string().description('ChatGPT backend base URL for the Responses API.'),
  clientVersion: Schema.string().description(
    'Client version reported to the backend (empty = latest published @openai/codex, fetched from npm).',
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
  /** Explicit client-version override; undefined = derive from npm. */
  clientVersion?: string
  refreshMarginMs: number
  defaultContextWindow: number
  defaultReasoningEffort: string
  defaultReasoningEfforts: string[]
}

/**
 * Resolve validated connection facts from a raw config snapshot. Every default
 * and bound is re-judged here so a settings edit fails loudly at first use.
 */
export function resolveAdapterOptions(config: ResolvedChatGptConfig = {}): ResolvedOptions {
  const refreshMarginMs = config.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS
  if (!Number.isFinite(refreshMarginMs) || refreshMarginMs <= 0) {
    throw new Error(`${PACKAGE_NAME}/chatgpt: refreshMarginMs must be a positive number`)
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error(`${PACKAGE_NAME}/chatgpt: defaultContextWindow must be a positive integer`)
  }
  return {
    baseURL: (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    clientVersion: config.clientVersion || undefined,
    refreshMarginMs,
    defaultContextWindow,
    defaultReasoningEffort: 'high',
    defaultReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
  }
}

export interface RegisterChatGptDeps {
  channel: AuthChannel
  /** Live reader for this provider's configuration snapshot. */
  config: () => ResolvedChatGptConfig
  /** Shared OAuth token service this module registers its resolver into. */
  tokens?: OAuthProvidersService
}

/** Wire the ChatGPT provider: LLM route, catalog, token store, settings, sign-in. */
export function registerChatGpt(ctx: Context, { channel, tokens, config }: RegisterChatGptDeps): void {
  const log = ctx.logger(`${PACKAGE_NAME}/chatgpt`)
  const current: () => ResolvedChatGptConfig = config
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

  // Proxy-aware fetch, resolved once on first use: explicit config is gone,
  // standard environment / system-proxy detection still applies.
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
  tokens?.register(PROVIDER, () => tokenStore.resolve())
  const catalog = new ModelCatalog({ fetch: fetchVia, options })
  const adapter = new OpenAiOauthAdapter({ options, tokenStore, catalog, getFetch })

  // 0.2 settings model: the settings namespace IS this plugin's profile entry
  // id, and the editable section is the row config's `chatgpt` sub-object —
  // `@deepseek-ai/dsh-settings` projects this entry's Config schema
  // automatically (0.1's `settings.installSection` is gone). A Settings edit
  // commits into the running fiber's volatile `chatgpt` reference, which
  // `current()` below reads live; `options()` re-resolves on the next use.
  // `fiber.entry` is attached at runtime by cordis-plugin-loader (untyped in
  // cordis 4.0.4's Fiber declaration); fall back to the stock row id.
  const entry = (ctx.fiber as { entry?: { options: { id: string } } }).entry
  const settingsNs = entry?.options.id ?? SETTINGS_NAMESPACE
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs,
      settingsPath: ['chatgpt'],
    },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerModelDiscovery(settingsNs, createDiscovery({ options, tokenStore, catalog }))

  registerChatGptSignIn(ctx, { key: CREDENTIAL_KEY, fetch: fetchVia, channel, settingsNs })
}
