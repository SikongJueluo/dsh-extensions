/**
 * Search provider adapters. Each adapter normalizes one vendor's response into `RawHit`s; cross-source identity is NOT their business (the evidence layer owns dedup).
 * @module dsh-search-integrator/providers
 */
import { fetchRawPost, mcpCallTool } from './mcp.js'
import type { McpToolResult, RawPost } from './mcp.js'
import { getJson, postJson, withRetry } from './http.js'
import type { SearchIntegratorSettings } from './settings.js'
import type { RawHit, SourceFailure } from './types.js'
import { isRecord } from './types.js'

/** A `RawHit` without the readonly modifiers, for field-by-field construction. */
type RawHitDraft = { -readonly [K in keyof RawHit]: RawHit[K] }

/** A fresh OAuth token pair handed out by the oauth-providers service. */
export interface OAuthTokenPair {
  readonly access: string
  readonly accountId?: string
}

/** IO surface the adapters need; every half is injectable for tests. */
export interface AdapterIo {
  readonly postJson: typeof postJson
  readonly getJson: typeof getJson
  readonly rawPost: RawPost
  readonly chatgptToken?: () => Promise<OAuthTokenPair | undefined>
}

/** What an adapter needs to run: settings snapshot + resolved API key. */
export interface AdapterConfig {
  readonly id: 'zhipu' | 'tavily' | 'exa' | 'brave' | 'openai' | 'chatgpt'
  readonly apiKey: string
  readonly settings: SearchIntegratorSettings
  readonly io: AdapterIo
}

/** One normalized search source bound to a provider. */
export interface SearchAdapter {
  readonly id: string
  search(query: string, signal: AbortSignal): Promise<RawHit[]>
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`${where}: expected a non-empty string`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function zhipuHitsFrom(entry: readonly unknown[] | undefined, query: string): RawHit[] {
  return (entry ?? []).map((raw, index) => {
    const hit = isRecord(raw) ? raw : {}
    return {
      provider: 'zhipu',
      query,
      url: requireString(hit.link, `zhipu search_result[${index}].link`),
      title: optionalString(hit.title),
      snippet: optionalString(hit.content),
      publishedAt: optionalString(hit.publish_date),
    }
  })
}

/** The MCP tool result carries hits either REST-shaped, or as a bare JSON array (webSearchPrime). */
function zhipuHitsFromToolResult(result: McpToolResult, query: string): RawHit[] {
  const structured = isRecord(result.structured) ? result.structured : undefined
  const structuredHits: readonly unknown[] | undefined =
    structured !== undefined && Array.isArray(structured.search_result)
      ? structured.search_result
      : undefined
  if (structuredHits !== undefined) return zhipuHitsFrom(structuredHits, query)
  if (result.text !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(result.text)
      if (typeof parsed === 'string' && parsed !== '') {
        parsed = JSON.parse(parsed)
      }
    } catch (error) {
      throw new Error('zhipu mcp: tool result text was not valid JSON', { cause: error })
    }
    if (isRecord(parsed) && Array.isArray(parsed.search_result)) {
      const hits: readonly unknown[] = parsed.search_result
      return zhipuHitsFrom(hits, query)
    }
    if (Array.isArray(parsed)) {
      const hits: readonly unknown[] = parsed
      return zhipuHitsFrom(hits, query)
    }
  }
  throw new Error('zhipu mcp: tool result carried no search hits array')
}

async function zhipuSearchMcp(
  config: AdapterConfig,
  query: string,
  signal: AbortSignal,
): Promise<RawHit[]> {
  const { settings } = config
  const attempt = (): Promise<McpToolResult> =>
    mcpCallTool(
      config.io.rawPost,
      settings.zhipuMcpUrl,
      config.apiKey,
      settings.zhipuMcpTool,
      {
        search_query: query,
        search_engine: settings.zhipuEngine,
        count: settings.perSourceResults,
      },
      signal,
    )
  let result: McpToolResult
  try {
    result = await attempt()
  } catch (error) {
    if (!signal.aborted && error instanceof TypeError) {
      result = await attempt()
    } else {
      throw error
    }
  }
  return zhipuHitsFromToolResult(result, query)
}

function createZhipuAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'zhipu',
    async search(query, signal) {
      if (settings.zhipuTransport === 'mcp') return zhipuSearchMcp(config, query, signal)
      const body = await withRetry(
        () =>
          io.postJson(
            `${settings.zhipuApiBase.replace(/\/$/u, '')}/web_search`,
            {
              search_query: query.slice(0, 70 * 4),
              search_engine: settings.zhipuEngine,
              search_intent: false,
              count: settings.perSourceResults,
              content_size: 'high',
            },
            { authorization: `Bearer ${config.apiKey}` },
            signal,
          ),
        { signal, retries: 1 },
      )
      return zhipuHitsFrom(
        isRecord(body) && Array.isArray(body.search_result) ? body.search_result : undefined,
        query,
      )
    },
  }
}

function createTavilyAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'tavily',
    async search(query, signal) {
      const body = await withRetry(
        () =>
          io.postJson(
            `${settings.tavilyApiBase.replace(/\/$/u, '')}/search`,
            {
              query,
              max_results: settings.perSourceResults,
              search_depth: settings.tavilySearchDepth,
              include_answer: false,
              ...(settings.tavilyIncludeRaw ? { include_raw_content: true } : {}),
            },
            { authorization: `Bearer ${config.apiKey}` },
            signal,
          ),
        { signal, retries: 1 },
      )
      const results: readonly unknown[] =
        isRecord(body) && Array.isArray(body.results) ? body.results : []
      return results.map((raw, index) => {
        const entry = isRecord(raw) ? raw : {}
        const hit: RawHitDraft = {
          provider: 'tavily',
          query,
          url: requireString(entry.url, `tavily results[${index}].url`),
          title: optionalString(entry.title),
          snippet: optionalString(entry.content),
        }
        if (settings.tavilyIncludeRaw) hit.content = optionalString(entry.raw_content)
        hit.publishedAt = optionalString(entry.published_date)
        return hit
      })
    },
  }
}

function createExaAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'exa',
    async search(query, signal) {
      const body = await withRetry(
        () =>
          io.postJson(
            `${settings.exaApiBase.replace(/\/$/u, '')}/search`,
            {
              query,
              numResults: settings.perSourceResults,
              type: 'auto',
              contents: { text: { maxCharacters: settings.excerptChars * 2 } },
            },
            { 'x-api-key': config.apiKey },
            signal,
          ),
        { signal, retries: 1 },
      )
      const results: readonly unknown[] =
        isRecord(body) && Array.isArray(body.results) ? body.results : []
      return results.map((raw, index) => {
        const entry = isRecord(raw) ? raw : {}
        return {
          provider: 'exa',
          query,
          url: requireString(entry.url, `exa results[${index}].url`),
          title: optionalString(entry.title),
          snippet: optionalString(entry.text),
          publishedAt: optionalString(entry.publishedDate),
        }
      })
    },
  }
}

function createBraveAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'brave',
    async search(query, signal) {
      const url = `${settings.braveApiBase.replace(/\/$/u, '')}/web/search?${new URLSearchParams({
        q: query,
        count: String(settings.perSourceResults),
        extra_snippets: 'true',
      }).toString()}`
      const body = await withRetry(
        () =>
          io.getJson(
            url,
            {
              accept: 'application/json',
              'x-subscription-token': config.apiKey,
            },
            signal,
          ),
        { signal, retries: 1 },
      )
      const web = isRecord(body) && isRecord(body.web) ? body.web : undefined
      const results: readonly unknown[] =
        web !== undefined && Array.isArray(web.results) ? web.results : []
      return results.map((raw, index) => {
        const entry = isRecord(raw) ? raw : {}
        const hit: RawHitDraft = {
          provider: 'brave',
          query,
          url: requireString(entry.url, `brave web.results[${index}].url`),
          title: optionalString(entry.title),
          snippet: optionalString(entry.description),
          publishedAt: optionalString(entry.age),
        }
        const extras: unknown[] = Array.isArray(entry.extra_snippets) ? entry.extra_snippets : []
        if (extras.length > 0) {
          hit.content = extras.filter((part): part is string => typeof part === 'string').join('\n')
        }
        return hit
      })
    },
  }
}

/** The OpenAI source is search-grounded generation, not a raw SERP: the integrator consumes ONLY the consulted/cited URLs (titles when present) and discards the generated prose - generated text is never evidence. */
function createOpenaiAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'openai',
    async search(query, signal) {
      const body = await withRetry(
        () =>
          io.postJson(
            `${settings.openaiApiBase.replace(/\/$/u, '')}/responses`,
            {
              model: settings.openaiModel,
              tools: [
                { type: 'web_search', search_context_size: settings.openaiSearchContextSize },
              ],
              tool_choice: 'required',
              include: ['web_search_call.action.sources'],
              ...(settings.openaiReasoningEffort === ''
                ? {}
                : { reasoning: { effort: settings.openaiReasoningEffort } }),
              input: query,
            },
            { authorization: `Bearer ${config.apiKey}` },
            signal,
          ),
        { signal, retries: 1 },
      )
      const byUrl = new Map<string, { url: string; title?: string }>()
      const output: readonly unknown[] =
        isRecord(body) && Array.isArray(body.output) ? body.output : []
      for (const raw of output) {
        const item = isRecord(raw) ? raw : {}
        if (item.type === 'web_search_call') {
          const action = isRecord(item.action) ? item.action : {}
          const sources: readonly unknown[] = Array.isArray(action.sources) ? action.sources : []
          for (const rawSource of sources) {
            const source = isRecord(rawSource) ? rawSource : {}
            const url = optionalString(source.url)
            if (url === undefined) continue
            const title = optionalString(source.title)
            if (!byUrl.has(url)) byUrl.set(url, title === undefined ? { url } : { url, title })
          }
        }
        if (item.type === 'message') {
          const blocks: readonly unknown[] = Array.isArray(item.content) ? item.content : []
          for (const rawBlock of blocks) {
            const block = isRecord(rawBlock) ? rawBlock : {}
            const annotations: readonly unknown[] = Array.isArray(block.annotations)
              ? block.annotations
              : []
            for (const rawAnnotation of annotations) {
              const annotation = isRecord(rawAnnotation) ? rawAnnotation : {}
              if (annotation.type !== 'url_citation') continue
              const url = optionalString(annotation.url)
              if (url === undefined || byUrl.has(url)) continue
              const title = optionalString(annotation.title)
              byUrl.set(url, title === undefined ? { url } : { url, title })
            }
          }
        }
      }
      if (byUrl.size === 0) {
        throw new Error('openai: web_search returned no consultable source URLs')
      }
      return [...byUrl.values()].slice(0, settings.perSourceResults).map((source) => {
        const hit: RawHitDraft = { provider: 'openai', query, url: source.url }
        if (source.title !== undefined) hit.title = source.title
        hit.snippet = ''
        return hit
      })
    },
  }
}

/** Extract consulted URLs from a Codex-backend SSE transcript: `open_page` search actions (pages the model actually opened) plus `url_citation` annotations (title-bearing). Generated prose is discarded - only the URLs are evidence. */
function extractCodexSources(sseText: string): { url: string; title?: string }[] {
  const byUrl = new Map<string, { url: string; title?: string }>()
  const put = (url: unknown, title: unknown): void => {
    if (typeof url !== 'string' || url === '' || byUrl.has(url)) return
    byUrl.set(url, { url, ...(typeof title === 'string' && title !== '' ? { title } : {}) })
  }
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue
    let frame: unknown
    try {
      frame = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    if (!isRecord(frame)) continue
    const item = isRecord(frame.item) ? frame.item : undefined
    if (frame.type === 'response.output_item.done' && item?.type === 'web_search_call') {
      const action = isRecord(item.action) ? item.action : undefined
      if (action?.type === 'open_page') put(action.url, undefined)
    }
    if (frame.type === 'response.output_text.annotation.added') {
      const annotation = isRecord(frame.annotation) ? frame.annotation : undefined
      if (annotation?.type === 'url_citation') {
        put(annotation.url, annotation.title)
      }
    }
    if (frame.type === 'response.completed') {
      const response = isRecord(frame.response) ? frame.response : undefined
      const output: readonly unknown[] =
        response !== undefined && Array.isArray(response.output) ? response.output : []
      for (const entry of output) {
        const outputItem = isRecord(entry) ? entry : {}
        if (outputItem.type === 'message') {
          const blocks: readonly unknown[] = Array.isArray(outputItem.content)
            ? outputItem.content
            : []
          for (const block of blocks) {
            const blockRecord = isRecord(block) ? block : {}
            const annotations: readonly unknown[] = Array.isArray(blockRecord.annotations)
              ? blockRecord.annotations
              : []
            for (const annotation of annotations) {
              const citation = isRecord(annotation) ? annotation : {}
              if (citation.type === 'url_citation') put(citation.url, citation.title)
            }
          }
        }
      }
    }
  }
  return [...byUrl.values()]
}

function createChatgptAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'chatgpt',
    async search(query, signal) {
      const token = await io.chatgptToken?.()
      if (token === undefined) {
        throw new Error(
          'chatgpt: oauth-providers service unavailable or not signed in (Settings → OAuth Providers)',
        )
      }
      const url = `${settings.chatgptApiBase.replace(/\/$/u, '')}/responses`
      const body = JSON.stringify({
        model: settings.chatgptModel,
        instructions: 'Search the web and answer briefly, citing every source you used inline.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
        tools: [{ type: 'web_search' }],
        stream: true,
        store: false,
      })
      const response = await io.rawPost(
        url,
        body,
        {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          originator: 'dsh-search-integrator',
          authorization: `Bearer ${token.access}`,
          ...(token.accountId === undefined ? {} : { 'chatgpt-account-id': token.accountId }),
          'oai-product-sku': 'codex',
        },
        signal,
      )
      if (response.status !== 200) {
        throw new Error(`chatgpt codex: HTTP ${response.status}: ${response.text.slice(0, 200)}`)
      }
      const sources = extractCodexSources(response.text)
      if (sources.length === 0) {
        throw new Error('chatgpt: web_search consulted no citable source URLs')
      }
      return sources.slice(0, settings.perSourceResults).map((source) => {
        const hit: RawHitDraft = { provider: 'chatgpt', query, url: source.url }
        if (source.title !== undefined) hit.title = source.title
        hit.snippet = ''
        return hit
      })
    },
  }
}

/**
 * Build the enabled adapters from a settings snapshot and resolved keys.
 * @param settings - live settings snapshot.
 * @param keys - resolved API keys by provider id.
 * @param io - injectable network IO (tests script both halves).
 * @returns adapters plus `SourceFailure`s for enabled-but-unusable sources.
 */
export function buildAdapters(
  settings: SearchIntegratorSettings,
  keys: Readonly<Partial<Record<AdapterConfig['id'], string>>>,
  io?: AdapterIo,
): { adapters: SearchAdapter[]; failures: SourceFailure[] } {
  const liveIo: AdapterIo = io ?? { postJson, getJson, rawPost: fetchRawPost() }
  const adapters: SearchAdapter[] = []
  const failures: SourceFailure[] = []
  const wanted: AdapterConfig['id'][] = []
  if (settings.zhipuEnabled) wanted.push('zhipu')
  if (settings.tavilyEnabled) wanted.push('tavily')
  if (settings.exaEnabled) wanted.push('exa')
  if (settings.braveEnabled) wanted.push('brave')
  if (settings.openaiEnabled) wanted.push('openai')
  if (settings.chatgptEnabled && liveIo.chatgptToken === undefined) {
    failures.push({
      source: 'chatgpt',
      reason: 'oauth-providers service not mounted (install/sign in to oauth-providers first)',
    })
  }
  for (const id of wanted) {
    const apiKey = keys[id]
    if (apiKey === undefined || apiKey === '') {
      failures.push({
        source: id,
        reason: `API key not configured (credential reference resolves to nothing)`,
      })
      continue
    }
    const config: AdapterConfig = { id, apiKey, settings, io: liveIo }
    if (id === 'zhipu') adapters.push(createZhipuAdapter(config))
    if (id === 'tavily') adapters.push(createTavilyAdapter(config))
    if (id === 'exa') adapters.push(createExaAdapter(config))
    if (id === 'brave') adapters.push(createBraveAdapter(config))
    if (id === 'openai') adapters.push(createOpenaiAdapter(config))
  }
  if (settings.chatgptEnabled && liveIo.chatgptToken !== undefined) {
    adapters.push(createChatgptAdapter({ id: 'chatgpt', apiKey: '', settings, io: liveIo }))
  }
  const generativeMs = settings.perRequestTimeoutMs * 4
  const bounded = adapters.map((adapter): SearchAdapter => {
    const deadlineMs =
      adapter.id === 'chatgpt' || adapter.id === 'openai'
        ? generativeMs
        : settings.perRequestTimeoutMs
    return {
      id: adapter.id,
      async search(query, signal) {
        return adapter.search(query, AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]))
      },
    }
  })
  return { adapters: bounded, failures }
}

/** A scripted adapter for tests and local dry runs. */
export function createFakeAdapter(
  id: string,
  respond: (query: string, signal: AbortSignal) => RawHit[] | Promise<RawHit[]>,
): SearchAdapter {
  return {
    id,
    async search(query, signal) {
      return respond(query, signal)
    },
  }
}
