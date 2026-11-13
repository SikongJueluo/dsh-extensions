/**
 * The Command Code subscription provider: one `command-code` route whose live
 * catalog spans anthropic-messages, openai-responses and openai-completions.
 *
 * The model list comes from `GET /provider/v1/models` at startup; the route is
 * registered only when an API key is present, so an installed bundle with no
 * key stays dormant. The wire rules (per-model protocol, base URL, adaptive
 * thinking, developer-role compatibility, ZDR header) mirror the official pi
 * provider at https://github.com/CommandCodeAI/pi-commandcode-provider.
 *
 * @module dsh-more-providers/commandcode
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from '@earendil-works/pi-ai/compat'
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import Schema from '@deepseek-ai/schemastery'
import { PACKAGE_NAME } from './identity.js'

/** The harness route id (shared with dsh-plan-usage's quota source). */
export const COMMAND_CODE_ROUTE = 'command-code'

/** Provider API root; the Anthropic SDK appends `/v1/messages` itself. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider'

/** OpenAI-compatible base; `/responses` and `/chat/completions` hang off it. */
export const DEFAULT_OPENAI_BASE_URL = `${DEFAULT_BASE_URL}/v1`

/** Unauthenticated model catalog. */
export const DEFAULT_MODELS_URL = `${DEFAULT_OPENAI_BASE_URL}/models`

/** Request header that enforces zero-data-retention routing. */
const ZDR_HEADER = 'x-cmd-zdr'
const ZDR_ENV = 'CMD_ZDR'
const MODELS_URL_ENV = 'CMD_MODELS_URL'

/** Fallback credential env accepted by the official pi provider as well. */
const FALLBACK_API_KEY_ENV = 'COMMAND_CODE_API_KEY'

const FALLBACK_CONTEXT_WINDOW = 131_072
const FALLBACK_MAX_TOKENS = 32_768

/** dsh-llm's default normal-mode retry policy for one provider route. */
const DEFAULT_RETRY_POLICY = {
  mode: 'normal' as const,
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
}

/** Claude models from Opus/Sonnet 4.6 and Fable 5 onward require adaptive thinking. */
const ADAPTIVE_THINKING = /(opus[-.](4[-.]6|4[-.]7|4[-.]8|5)|sonnet[-.](4[-.]6|5)|fable[-.]5|mythos[-.]5)/

/** Vision-capable families while the catalog reports no modalities. */
const VISION_FAMILIES = [/^claude-/, /^gpt-/, /^google\//]

/** One entry from `GET /provider/v1/models`. */
export interface CommandCodeCatalogItem {
  id: string
  name?: string
  context_length?: number
  supported_endpoints?: string[]
  pricing?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  max_output_tokens?: number
  modalities?: { input?: string[] }
  reasoning?: boolean
}

/** Plugin-row configuration for this provider. */
export interface CommandCodeSettings {
  /** Register the route when a key resolves; false keeps it dormant. */
  enabled: boolean
  /** Env var holding the API key. */
  apiKeyEnv: string
  /** Provider API root. */
  baseURL: string
  /** Model catalog endpoint; `CMD_MODELS_URL` overrides at runtime. */
  modelsURL: string
  /** Name shown by selectors. */
  displayName: string
  /** Send `x-cmd-zdr: 1`; `CMD_ZDR=1` also enables it. */
  zdr: boolean
  /** Catalog request timeout (ms). */
  timeoutMs: number
}

export const CommandCodeConfig: Schema<CommandCodeSettings> = Schema.object({
  enabled: Schema.boolean().default(true).description('Register the route when an API key resolves.'),
  apiKeyEnv: Schema.string().default('CMD_API_KEY').description('Env var holding the Command Code API key.'),
  baseURL: Schema.string().default(DEFAULT_BASE_URL).description('Command Code provider API root.'),
  modelsURL: Schema.string().default(DEFAULT_MODELS_URL).description('Model catalog endpoint (CMD_MODELS_URL overrides).'),
  displayName: Schema.string().default('Command Code').description('Provider name shown in model selectors.'),
  zdr: Schema.boolean().default(false).description('Send x-cmd-zdr: 1 for zero-data-retention routing (CMD_ZDR=1 also enables it).'),
  timeoutMs: Schema.number().step(1).min(1_000).default(10_000).description('Catalog request timeout in milliseconds.'),
})

/** Fetch implementation shape, injectable for the smoke test. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Runtime inputs that do not come from the plugin row. */
export interface CommandCodeDeps {
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isCatalogItem(value: unknown): value is CommandCodeCatalogItem {
  return asRecord(value) !== undefined && typeof (value as Record<string, unknown>).id === 'string'
}

/**
 * Parse a `/provider/v1/models` body. Accepts the standard `{ data: [...] }`
 * envelope and a bare array; malformed entries are dropped rather than
 * failing the whole catalog.
 */
export function parseCatalog(body: unknown): CommandCodeCatalogItem[] {
  const data = Array.isArray(body) ? body : asRecord(body)?.data
  if (!Array.isArray(data)) throw new Error('Command Code /models response carried no data array')
  return data.filter(isCatalogItem)
}

/** The protocol one catalog entry must use; the gateway rejects any other. */
function apiOf(item: CommandCodeCatalogItem): Api | undefined {
  const endpoints = item.supported_endpoints ?? []
  if (endpoints.includes('/messages')) return 'anthropic-messages'
  if (endpoints.includes('/responses') && item.id.startsWith('gpt-')) return 'openai-responses'
  if (endpoints.includes('/chat/completions')) return 'openai-completions'
  if (endpoints.includes('/responses')) return 'openai-responses'
  return undefined
}

/** Declared modalities when the endpoint reports them, else the family fallback. */
function inputOf(item: CommandCodeCatalogItem): Array<'text' | 'image'> {
  const declared = item.modalities?.input?.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
  if (declared !== undefined && declared.length > 0) return declared
  return VISION_FAMILIES.some((family) => family.test(item.id)) ? ['text', 'image'] : ['text']
}

function costOf(item: CommandCodeCatalogItem): Model<Api>['cost'] {
  const pricing = item.pricing
  if (pricing === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    input: finite(pricing.input) ?? 0,
    output: finite(pricing.output) ?? 0,
    cacheRead: finite(pricing.cache_read) ?? 0,
    cacheWrite: finite(pricing.cache_write) ?? 0,
  }
}

/**
 * Map catalog entries to pi-ai models. Entries whose endpoints this provider
 * cannot serve, or that the catalog does not route, are skipped.
 */
export function toPiModels(
  items: readonly CommandCodeCatalogItem[],
  options: { baseURL: string; provider: string },
): Model<Api>[] {
  const openaiBaseURL = `${options.baseURL.replace(/\/+$/, '')}/v1`
  const models: Model<Api>[] = []
  for (const item of items) {
    const api = apiOf(item)
    if (api === undefined) continue
    const model: Model<Api> = {
      id: item.id,
      name: item.name || item.id,
      api,
      provider: options.provider,
      baseUrl: api === 'anthropic-messages' ? options.baseURL.replace(/\/+$/, '') : openaiBaseURL,
      reasoning: item.reasoning ?? true,
      input: inputOf(item),
      cost: costOf(item),
      contextWindow: item.context_length || FALLBACK_CONTEXT_WINDOW,
      maxTokens: item.max_output_tokens || FALLBACK_MAX_TOKENS,
    }
    if (api === 'openai-completions') {
      model.compat = { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
    } else if (api === 'anthropic-messages' && ADAPTIVE_THINKING.test(item.id)) {
      model.compat = { forceAdaptiveThinking: true }
    }
    models.push(model)
  }
  return models
}

/** Fetch and parse the live catalog; throws on a non-2xx or malformed body. */
export async function fetchCatalog(
  url: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<CommandCodeCatalogItem[]> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Command Code /models returned ${response.status}`)
  return parseCatalog(await response.json())
}

/** Resolve the API key from the configured env var, then the pi fallback. */
export function resolveApiKey(config: Pick<CommandCodeSettings, 'apiKeyEnv'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of [config.apiKeyEnv, FALLBACK_API_KEY_ENV]) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** Credential plumbing PiAiAdapter requires even when every request carries an apiKey. */
const AUTH: PiAiAdapterOptions['auth'] = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  },
  authContext: {
    env: async (name) => process.env[name],
    fileExists: async () => false,
  },
}

/** One catalog snapshot materialized for registration. */
export interface CommandCodeRegistration {
  adapter: PiAiAdapter
  modelCount: number
}

/**
 * Build the adapter for one catalog snapshot. The profile carries the route
 * defaults PiAiAdapter reads per operation; the key is returned by
 * `resolveApiKey`, so pi-ai's credential store is never consulted.
 */
export function createCommandCodeAdapter(
  items: readonly CommandCodeCatalogItem[],
  config: CommandCodeSettings,
  apiKey: string,
): CommandCodeRegistration | undefined {
  const models = toPiModels(items, { baseURL: config.baseURL, provider: COMMAND_CODE_ROUTE })
  if (models.length === 0) return undefined
  const provider = createProvider({
    id: COMMAND_CODE_ROUTE,
    name: config.displayName,
    auth: { apiKey: envApiKeyAuth('Command Code API key', ['CMD_API_KEY', FALLBACK_API_KEY_ENV]) },
    models,
    api: {
      'anthropic-messages': anthropicMessagesApi(),
      'openai-responses': openAIResponsesApi(),
      'openai-completions': openAICompletionsApi(),
    },
  })
  const profile: ResolvedPiAiProviderProfile = {
    provider: COMMAND_CODE_ROUTE,
    displayName: config.displayName,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20_971_520,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: DEFAULT_RETRY_POLICY,
    piProvider: provider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    ...(config.zdr ? { headers: { [ZDR_HEADER]: '1' } } : {}),
  }
  const profiles = new Map([[COMMAND_CODE_ROUTE, profile]])
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => apiKey,
      auth: AUTH,
    }),
    modelCount: models.length,
  }
}

/**
 * Register the route when the environment resolves a key. A missing key is a
 * normal dormant state; a catalog failure is logged and leaves the route
 * unregistered rather than serving an empty provider.
 */
export async function registerCommandCode(ctx: Context, config: CommandCodeSettings, deps: CommandCodeDeps = {}): Promise<void> {
  const log = ctx.logger(PACKAGE_NAME)
  const env = deps.env ?? process.env
  const apiKey = resolveApiKey(config, env)
  if (apiKey === undefined) {
    log.info('command-code: no API key in %s or %s; route stays dormant', config.apiKeyEnv, FALLBACK_API_KEY_ENV)
    return
  }
  const modelsURL = env[MODELS_URL_ENV]?.trim() || config.modelsURL
  const zdr = config.zdr || env[ZDR_ENV] === '1'
  let items: CommandCodeCatalogItem[]
  try {
    items = await fetchCatalog(modelsURL, config.timeoutMs, deps.fetchImpl)
  } catch (error) {
    log.error('command-code: model catalog unavailable at %s: %o', modelsURL, error)
    return
  }
  const registration = createCommandCodeAdapter(items, { ...config, zdr }, apiKey)
  if (registration === undefined) {
    log.error('command-code: catalog at %s carried no usable models', modelsURL)
    return
  }
  ctx.llm.registerAdapter([COMMAND_CODE_ROUTE], registration.adapter)
  log.info('command-code: registered %d models (zdr=%s)', registration.modelCount, zdr ? 'on' : 'off')
}
