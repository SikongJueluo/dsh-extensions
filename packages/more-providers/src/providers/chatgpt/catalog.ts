/**
 * ChatGPT model catalog.
 * @module dsh-more-providers/providers/chatgpt/catalog
 */
import type { Logger } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { debugQuietly } from '../../diagnostics.js'
import { readJson } from '../../oauth/transport.js'
import type { FetchLike } from '../../oauth/transport.js'
import { isRecord } from '../../record.js'

/** Input modality vocabulary shared with the harness model catalog. */
export type InputModality = 'text' | 'image'

const DEFAULT_INPUT_MODALITIES: readonly InputModality[] = ['text', 'image']

/** One model entry in the internal catalog. */
export interface ModelEntry {
  id: string
  name: string
  contextWindow?: number
  reasoning: string[]
  inputModalities: readonly InputModality[]
}

const FALLBACK_CLIENT_VERSION = '0.157.1'
const NPM_CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest'

/** Connection facts the catalog fetcher needs. */
export interface CatalogOptions {
  baseURL: string
  clientVersion?: string
}

export const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export const REASONING_EFFORT_NAMES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
}

/** Keep the modalities the harness understands; unknown lists fall back to the default. */
function parseInputModalities(value: unknown): readonly InputModality[] {
  if (!Array.isArray(value)) return DEFAULT_INPUT_MODALITIES
  const kept = DEFAULT_INPUT_MODALITIES.filter((modality) => value.includes(modality))
  return kept.length > 0 ? kept : DEFAULT_INPUT_MODALITIES
}

/** Parse the ChatGPT `/models` payload into the internal catalog shape. */
function parseModelsPayload(payload: unknown): ModelEntry[] {
  const list = isRecord(payload) && Array.isArray(payload.models) ? payload.models : []
  const out: ModelEntry[] = []
  for (const model of list) {
    if (!isRecord(model)) continue
    const slug = model.slug
    if (typeof slug !== 'string' || slug === '') continue
    if (model.supported_in_api === false) continue
    const levels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : []
    const reasoning = levels
      .map((level) => (isRecord(level) ? level.effort : undefined))
      .filter((effort): effort is string => typeof effort === 'string')
    const displayName = model.display_name
    const modelName = model.name
    out.push({
      id: slug,
      name:
        typeof displayName === 'string' && displayName !== ''
          ? displayName
          : typeof modelName === 'string' && modelName !== ''
            ? modelName
            : slug,
      ...(typeof model.context_window === 'number' ? { contextWindow: model.context_window } : {}),
      reasoning,
      inputModalities: parseInputModalities(model.input_modalities),
    })
  }
  return out
}

export interface ModelCatalogOptions {
  fetch: FetchLike
  options: CatalogOptions
  ttlMs?: number
  logger?: Logger
}

export class ModelCatalog {
  private readonly fetch: FetchLike
  private readonly options: CatalogOptions
  private readonly ttlMs: number
  private readonly logger: Logger | undefined
  private live: ModelEntry[] | null = null
  private liveAt = 0
  private liveVersion = ''
  private refreshing: Promise<ModelEntry[]> | null = null
  private versionCache: { value: string; at: number } | undefined
  private versionFetching: Promise<string> | null = null

  constructor({ fetch, options, ttlMs = 2 * 60 * 60 * 1000, logger }: ModelCatalogOptions) {
    this.fetch = fetch
    this.options = options
    this.ttlMs = ttlMs
    this.logger = logger
  }

  /** Last-good live catalog (empty until a fetch succeeds). Never a static list. */
  current(): ModelEntry[] {
    return this.live ?? []
  }

  /** Look up one model's metadata, synthesizing a minimal entry when unknown. */
  resolve(model: string): ModelEntry {
    const found = this.current().find((entry) => entry.id === model)
    return (
      found ?? { id: model, name: model, reasoning: [], inputModalities: DEFAULT_INPUT_MODALITIES }
    )
  }

  /**
   * Return the live catalog, fetching when the cache is empty or stale. Throws when the live fetch fails, so callers surface the provider as offline instead of advertising a fabricated model list.
   * @param headers - optional request headers (e.g. OAuth auth) for the fetch.
   */
  async refresh(headers?: Record<string, string>): Promise<ModelEntry[]> {
    const clientVersion = await this.resolveClientVersion()
    if (this.live && Date.now() - this.liveAt < this.ttlMs && this.liveVersion === clientVersion)
      return this.live
    if (this.refreshing) return this.refreshing
    this.refreshing = this.fetchLive(headers, clientVersion)
    try {
      return await this.refreshing
    } finally {
      this.refreshing = null
    }
  }

  /** Manual refresh: always hit the backend, bypassing the cache. */
  async forceRefresh(headers?: Record<string, string>): Promise<ModelEntry[]> {
    return this.fetchLive(headers, await this.resolveClientVersion())
  }

  /** The client version reported to the backend: explicit config, then the latest published `@openai/codex` from the npm registry (cached for the same TTL as the catalog), then the bundled fallback for offline hosts. The registry query failing never fails the catalog. */
  private async resolveClientVersion(): Promise<string> {
    const explicit = this.options.clientVersion
    if (explicit) return explicit
    if (this.versionCache && Date.now() - this.versionCache.at < this.ttlMs)
      return this.versionCache.value
    this.versionFetching ??= (async () => {
      let value = this.versionCache?.value ?? FALLBACK_CLIENT_VERSION
      try {
        const response = await this.fetch(NPM_CODEX_LATEST_URL, {
          headers: { accept: 'application/json' },
        })
        if (response.ok) {
          const body: unknown = await response.json()
          const version = isRecord(body) ? body.version : undefined
          if (typeof version === 'string' && /^\d+\.\d+\.\d+/u.test(version)) value = version
        }
      } catch (error) {
        debugQuietly(
          this.logger,
          'chatgpt catalog: npm client-version lookup failed (%s); using %s',
          error,
          value,
        )
      }
      this.versionCache = { value, at: Date.now() }
      return value
    })().finally(() => {
      this.versionFetching = null
    })
    return this.versionFetching
  }

  private async fetchLive(
    headers: Record<string, string> | undefined,
    clientVersion: string,
  ): Promise<ModelEntry[]> {
    const { baseURL } = this.options
    const url = `${baseURL}/models?client_version=${encodeURIComponent(clientVersion)}`
    let response: Response
    try {
      response = await this.fetch(url, { headers: { accept: 'application/json', ...headers } })
    } catch (error) {
      throw new LlmError(
        `ChatGPT backend unreachable at ${baseURL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'CATALOG_UNREACHABLE',
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new LlmError(
        `ChatGPT model endpoint returned HTTP ${response.status}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : `HTTP_${response.status}`,
        { status: response.status },
      )
    }
    let payload: unknown
    try {
      payload = await readJson(response, 'ChatGPT /models endpoint')
    } catch (error) {
      throw new LlmError(
        error instanceof Error ? error.message : String(error),
        'CATALOG_INVALID_RESPONSE',
        { cause: error },
      )
    }
    const parsed = parseModelsPayload(payload)
    if (parsed.length === 0) {
      throw new LlmError('ChatGPT backend returned no usable models', 'EMPTY_CATALOG')
    }
    this.live = parsed
    this.liveAt = Date.now()
    this.liveVersion = clientVersion
    return this.live
  }
}
