/**
 * ChatGPT model catalog.
 *
 * There is no static fallback model list: the adapter only advertises what the
 * live ChatGPT backend `/models` endpoint reports. A failed live fetch raises
 * (so the harness model selector can mark the provider offline), while a
 * successful fetch is cached for a two-hour TTL so the selector stays responsive.
 *
 * Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai-oauth/catalog
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { readJson } from '../../transport.js'
import type { FetchLike } from '../../transport.js'

/** One model entry in the internal catalog. */
export interface ModelEntry {
  id: string
  name: string
  contextWindow?: number
  reasoning: string[]
}

/** Bundled fallback when neither config nor the npm registry answers. */
export const FALLBACK_CLIENT_VERSION = '0.157.1'
/** Where the newest published Codex client version is read from. */
const NPM_CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest'

/** Connection facts the catalog fetcher needs. */
export interface CatalogOptions {
  baseURL: string
  /** Explicit client-version override; absent = derive from npm. */
  clientVersion?: string
}

/** Reasoning-effort vocabulary shared by the ChatGPT backend (not a model list). */
export const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export const REASONING_EFFORT_NAMES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
}

interface RawModel {
  slug?: string
  display_name?: string
  name?: string
  context_window?: number
  supported_in_api?: boolean
  supported_reasoning_levels?: Array<{ effort?: string }>
}

/** Parse the ChatGPT `/models` payload into the internal catalog shape. */
export function parseModelsPayload(payload: unknown): ModelEntry[] {
  const list = (payload as { models?: RawModel[] } | null)?.models ?? []
  const out: ModelEntry[] = []
  for (const model of list) {
    const slug = model.slug
    if (!slug) continue
    if (model.supported_in_api === false) continue
    const reasoning = (model.supported_reasoning_levels ?? [])
      .map((level) => level.effort)
      .filter((effort): effort is string => typeof effort === 'string')
    out.push({
      id: slug,
      name: model.display_name || model.name || slug,
      ...(typeof model.context_window === 'number' ? { contextWindow: model.context_window } : {}),
      reasoning,
    })
  }
  return out
}

export interface ModelCatalogOptions {
  fetch: FetchLike
  options: () => CatalogOptions
  /** How long a successful fetch may be served from cache. */
  ttlMs?: number
}

export class ModelCatalog {
  private readonly fetch: FetchLike
  private readonly options: () => CatalogOptions
  private readonly ttlMs: number
  private live: ModelEntry[] | null = null
  private liveAt = 0
  private liveVersion = ''
  private refreshing: Promise<ModelEntry[]> | null = null
  private versionCache: { value: string; at: number } | undefined
  private versionFetching: Promise<string> | null = null

  constructor({ fetch, options, ttlMs = 2 * 60 * 60 * 1000 }: ModelCatalogOptions) {
    this.fetch = fetch
    this.options = options
    this.ttlMs = ttlMs
  }

  /** Last-good live catalog (empty until a fetch succeeds). Never a static list. */
  current(): ModelEntry[] {
    return this.live ?? []
  }

  /** Look up one model's metadata, synthesizing a minimal entry when unknown. */
  resolve(model: string): ModelEntry {
    const found = this.current().find((entry) => entry.id === model)
    return found ?? { id: model, name: model, reasoning: [] }
  }

  /**
   * Return the live catalog, fetching when the cache is empty or stale.
   * Throws when the live fetch fails, so callers surface the provider as
   * offline instead of advertising a fabricated model list.
   * @param headers - optional request headers (e.g. OAuth auth) for the fetch.
   */
  async refresh(headers?: Record<string, string>): Promise<ModelEntry[]> {
    const clientVersion = await this.resolveClientVersion()
    if (
      this.live && Date.now() - this.liveAt < this.ttlMs &&
      this.liveVersion === clientVersion
    ) return this.live
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

  /**
   * The client version reported to the backend: explicit config, then the
   * latest published `@openai/codex` from the npm registry (cached for the
   * same TTL as the catalog), then the bundled fallback for offline hosts.
   * The registry query failing never fails the catalog.
   */
  private async resolveClientVersion(): Promise<string> {
    const explicit = this.options().clientVersion
    if (explicit) return explicit
    if (this.versionCache && Date.now() - this.versionCache.at < this.ttlMs) return this.versionCache.value
    this.versionFetching ??= (async () => {
      let value = this.versionCache?.value ?? FALLBACK_CLIENT_VERSION
      try {
        const response = await this.fetch(NPM_CODEX_LATEST_URL, { headers: { accept: 'application/json' } })
        if (response.ok) {
          const version = ((await response.json()) as { version?: unknown })?.version
          if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) value = version
        }
      } catch {
        // Registry unreachable: keep the last good or the bundled fallback.
      }
      this.versionCache = { value, at: Date.now() }
      return value
    })().finally(() => {
      this.versionFetching = null
    })
    return this.versionFetching
  }

  private async fetchLive(headers: Record<string, string> | undefined, clientVersion: string): Promise<ModelEntry[]> {
    const { baseURL } = this.options()
    const url = `${baseURL}/models?client_version=${encodeURIComponent(clientVersion)}`
    let response: Response
    try {
      response = await this.fetch(url, { headers: { accept: 'application/json', ...headers } })
    } catch (error) {
      throw new LlmError(
        `ChatGPT backend unreachable at ${baseURL}: ${(error as Error).message}`,
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
      throw new LlmError((error as Error).message, 'CATALOG_INVALID_RESPONSE', { cause: error })
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
