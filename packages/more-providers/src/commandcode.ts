/**
 * The Command Code wire rules: one route whose catalog spans
 * anthropic-messages, openai-responses, and openai-completions.
 *
 * The model list comes from `GET /provider/v1/models`. The route is built by
 * the registry, which supplies the route id, display name, base URL, and key.
 * The per-model protocol, base URL, adaptive-thinking, developer-role, and
 * ZDR-header rules mirror the official pi provider at
 * https://github.com/CommandCodeAI/pi-commandcode-provider.
 *
 * @module dsh-more-providers/commandcode
 */
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from '@earendil-works/pi-ai/compat'

/** Provider API root; the Anthropic SDK appends `/v1/messages` itself. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider'

/** OpenAI-compatible base; `/responses` and `/chat/completions` hang off it. */
const DEFAULT_OPENAI_BASE_URL = `${DEFAULT_BASE_URL}/v1`

/** Unauthenticated model catalog. */
export const DEFAULT_MODELS_URL = `${DEFAULT_OPENAI_BASE_URL}/models`

/** Request header that enforces zero-data-retention routing. */
export const ZDR_HEADER = 'x-cmd-zdr'

const FALLBACK_CONTEXT_WINDOW = 131_072
const FALLBACK_MAX_TOKENS = 32_768

/** Claude models from Opus/Sonnet 4.6 and Fable 5 onward require adaptive thinking. */
const ADAPTIVE_THINKING =
  /(opus[-.](4[-.]6|4[-.]7|4[-.]8|5)|sonnet[-.](4[-.]6|5)|fable[-.]5|mythos[-.]5)/

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

/** Provider construction inputs from the registry. */
export interface CommandCodeProviderOptions {
  route: string
  displayName: string
  baseURL: string
  zdr: boolean
}

/** Fetch implementation shape, injectable for the smoke test. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

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
  const declared = item.modalities?.input?.filter(
    (value): value is 'text' | 'image' => value === 'text' || value === 'image',
  )
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
  const baseURL = options.baseURL.replace(/\/+$/, '')
  const openaiBaseURL = `${baseURL}/v1`
  const models: Model<Api>[] = []
  for (const item of items) {
    const api = apiOf(item)
    if (api === undefined) continue
    const model: Model<Api> = {
      id: item.id,
      name: item.name || item.id,
      api,
      provider: options.provider,
      baseUrl: api === 'anthropic-messages' ? baseURL : openaiBaseURL,
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

/** Build the mixed-protocol Command Code provider for one route. */
export function buildCommandCodeProvider(
  items: readonly CommandCodeCatalogItem[],
  options: CommandCodeProviderOptions,
): { provider: Provider; models: Model<Api>[] } {
  const models = toPiModels(items, { baseURL: options.baseURL, provider: options.route })
  const provider = createProvider({
    id: options.route,
    name: options.displayName,
    auth: {
      apiKey: envApiKeyAuth('Command Code API key', ['CMD_API_KEY', 'COMMAND_CODE_API_KEY']),
    },
    models,
    api: {
      'anthropic-messages': anthropicMessagesApi(),
      'openai-responses': openAIResponsesApi(),
      'openai-completions': openAICompletionsApi(),
    },
  })
  return { provider, models }
}
