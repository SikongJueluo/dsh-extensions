/**
 * Search provider adapters. Each adapter normalizes one vendor's response
 * into `RawHit`s; cross-source identity is NOT their business (the evidence
 * layer owns dedup).
 *
 * Zhipu defaults to the official MCP broker (`zhipuTransport: 'mcp'`) so a
 * GLM Coding-Plan key's MCP quota covers the calls; the open-platform REST
 * API stays available as `zhipuTransport: 'rest'` for per-call billing.
 *
 * The adapters take injectable IO (`postJson` for REST, `rawPost` for MCP)
 * so tests script them without a network. Response parsing is defensive: a
 * malformed body rejects with a provider-tagged error instead of poisoning
 * the pipeline.
 *
 * @module dsh-search-integrator/providers
 */
import { fetchRawPost, mcpCallTool } from './mcp.js'
import type { McpToolResult, RawPost } from './mcp.js'
import { getJson, postJson, withRetry } from './http.js'
import type { SearchIntegratorSettings } from './settings.js'
import type { RawHit, SourceFailure } from './types.js'

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
  /** Fresh ChatGPT-subscription token via ctx.oauthProviders (optional: absent service ⇒ config failure). */
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
  if (typeof value !== 'string' || value === '') throw new Error(`${where}: expected a non-empty string`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

// --- Zhipu (open.bigmodel.cn) ---

interface ZhipuHit {
  readonly title?: unknown
  readonly content?: unknown
  readonly link?: unknown
  readonly publish_date?: unknown
}

interface ZhipuResponse {
  readonly search_result?: readonly ZhipuHit[]
}

function zhipuHitsFrom(entry: readonly ZhipuHit[] | undefined, query: string): RawHit[] {
  return (entry ?? []).map((hit, index) => ({
    provider: 'zhipu',
    query,
    url: requireString(hit?.link, `zhipu search_result[${index}].link`),
    title: optionalString(hit?.title),
    snippet: optionalString(hit?.content),
    publishedAt: optionalString(hit?.publish_date),
  }))
}

/** The MCP tool result carries hits either REST-shaped, or as a bare JSON array (webSearchPrime). */
function zhipuHitsFromToolResult(result: McpToolResult, query: string): RawHit[] {
  const structured = (result.structured as ZhipuResponse | undefined)?.search_result
  if (Array.isArray(structured)) return zhipuHitsFrom(structured, query)
  if (result.text !== '') {
    try {
      let parsed: unknown = JSON.parse(result.text)
      // The Coding-Plan webSearchPrime tool double-encodes: content text is
      // JSON.stringify(hitsArray), which itself parses to a STRING first.
      if (typeof parsed === 'string' && parsed !== '') {
        parsed = JSON.parse(parsed)
      }
      // Shape 1: REST-like {search_result: [...]} (the open-platform broker).
      if (Array.isArray((parsed as ZhipuResponse | null)?.search_result)) {
        return zhipuHitsFrom((parsed as ZhipuResponse).search_result, query)
      }
      // Shape 2: a bare hits array (webSearchPrime), single or double encoded.
      if (Array.isArray(parsed)) {
        return zhipuHitsFrom(parsed as readonly ZhipuHit[], query)
      }
    } catch {
      // Fall through: the error below names the actual shape we saw.
    }
  }
  throw new Error('zhipu mcp: tool result carried no search hits array')
}

async function zhipuSearchMcp(config: AdapterConfig, query: string, signal: AbortSignal): Promise<RawHit[]> {
  const { settings } = config
  // One retry on a transport-level network failure; auth/quota errors
  // (McpTransportError with a broker code) fail fast to the source-failure path.
  const attempt = (): Promise<McpToolResult> => mcpCallTool(
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
        () => io.postJson(
          `${settings.zhipuApiBase.replace(/\/$/, '')}/web_search`,
          {
            search_query: query.slice(0, 70 * 4), // the docs advise short queries; hard cap defensively
            search_engine: settings.zhipuEngine,
            search_intent: false,
            count: settings.perSourceResults,
            content_size: 'high',
          },
          { authorization: `Bearer ${config.apiKey}` },
          signal,
        ).then((raw) => raw as ZhipuResponse),
        { signal, retries: 1 },
      )
      return zhipuHitsFrom(Array.isArray(body?.search_result) ? body.search_result : undefined, query)
    },
  }
}

// --- Tavily ---

interface TavilyHit {
  readonly title?: unknown
  readonly url?: unknown
  readonly content?: unknown
  readonly raw_content?: unknown | null
  readonly published_date?: unknown | null
}

interface TavilyResponse {
  readonly results?: readonly TavilyHit[]
}

function createTavilyAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'tavily',
    async search(query, signal) {
      const body = await withRetry(
        () => io.postJson(
          `${settings.tavilyApiBase.replace(/\/$/, '')}/search`,
          {
            query,
            max_results: settings.perSourceResults,
            search_depth: settings.tavilySearchDepth,
            include_answer: false,
            ...(settings.tavilyIncludeRaw ? { include_raw_content: true } : {}),
          },
          { authorization: `Bearer ${config.apiKey}` },
          signal,
        ).then((raw) => raw as TavilyResponse),
        { signal, retries: 1 },
      )
      const results: readonly TavilyHit[] = Array.isArray(body?.results) ? body.results : []
      return results.map((entry, index) => ({
        provider: 'tavily',
        query,
        url: requireString(entry?.url, `tavily results[${index}].url`),
        title: optionalString(entry?.title),
        snippet: optionalString(entry?.content),
        ...(settings.tavilyIncludeRaw
          ? { content: optionalString(entry?.raw_content) }
          : {}),
        publishedAt: optionalString(entry?.published_date),
      }))
    },
  }
}

// --- Exa ---

interface ExaHit {
  readonly title?: unknown
  readonly url?: unknown
  readonly text?: unknown
  readonly publishedDate?: unknown
}

interface ExaResponse {
  readonly results?: readonly ExaHit[]
}

function createExaAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'exa',
    async search(query, signal) {
      const body = await withRetry(
        () => io.postJson(
          `${settings.exaApiBase.replace(/\/$/, '')}/search`,
          {
            query,
            numResults: settings.perSourceResults,
            type: 'auto',
            contents: { text: { maxCharacters: settings.excerptChars * 2 } },
          },
          { 'x-api-key': config.apiKey },
          signal,
        ).then((raw) => raw as ExaResponse),
        { signal, retries: 1 },
      )
      const results: readonly ExaHit[] = Array.isArray(body?.results) ? body.results : []
      return results.map((entry, index) => ({
        provider: 'exa',
        query,
        url: requireString(entry?.url, `exa results[${index}].url`),
        title: optionalString(entry?.title),
        snippet: optionalString(entry?.text),
        publishedAt: optionalString(entry?.publishedDate),
      }))
    },
  }
}

// --- Brave Search API ---

interface BraveResponse {
  readonly web?: { readonly results?: readonly {
    title?: unknown
    url?: unknown
    description?: unknown
    age?: unknown
    extra_snippets?: readonly unknown[]
  }[] }
}

function createBraveAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'brave',
    async search(query, signal) {
      const url = `${settings.braveApiBase.replace(/\/$/, '')}/web/search?${new URLSearchParams({
        q: query,
        count: String(settings.perSourceResults),
        extra_snippets: 'true',
      })}`
      const body = await withRetry(
        () => io.getJson(url, {
          accept: 'application/json',
          'x-subscription-token': config.apiKey,
        }, signal).then((raw) => raw as BraveResponse),
        { signal, retries: 1 },
      )
      const results = Array.isArray(body?.web?.results) ? body.web?.results : []
      return results.map((entry, index) => ({
        provider: 'brave',
        query,
        url: requireString(entry?.url, `brave web.results[${index}].url`),
        title: optionalString(entry?.title),
        snippet: optionalString(entry?.description),
        publishedAt: optionalString(entry?.age),
        ...(Array.isArray(entry?.extra_snippets) && entry.extra_snippets.length > 0
          ? { content: (entry.extra_snippets as unknown[]).filter((part): part is string => typeof part === 'string').join('\n') }
          : {}),
      }))
    },
  }
}

// --- OpenAI Responses web_search tool ---

interface OpenAiResponse {
  readonly output?: readonly {
    type?: unknown
    // web_search_call with the sources included via include[]
    action?: { sources?: readonly { url?: unknown; title?: unknown }[] }
    // assistant message with url_citation annotations
    content?: readonly { annotations?: readonly { type?: unknown; url?: unknown; title?: unknown }[] }[]
  }[]
}

/**
 * The OpenAI source is search-grounded generation, not a raw SERP: the
 * integrator consumes ONLY the consulted/cited URLs (titles when present) and
 * discards the generated prose — generated text is never evidence.
 */
function createOpenaiAdapter(config: AdapterConfig): SearchAdapter {
  const { settings, io } = config
  return {
    id: 'openai',
    async search(query, signal) {
      const body = await withRetry(
        () => io.postJson(
          `${settings.openaiApiBase.replace(/\/$/, '')}/responses`,
          {
            model: settings.openaiModel,
            tools: [{ type: 'web_search', search_context_size: settings.openaiSearchContextSize }],
            tool_choice: 'required',
            include: ['web_search_call.action.sources'],
            ...(settings.openaiReasoningEffort === '' ? {} : { reasoning: { effort: settings.openaiReasoningEffort } }),
            input: query,
          },
          { authorization: `Bearer ${config.apiKey}` },
          signal,
        ).then((raw) => raw as OpenAiResponse),
        { signal, retries: 1 },
      )
      const byUrl = new Map<string, { url: string; title?: string }>()
      for (const item of body?.output ?? []) {
        if (item?.type === 'web_search_call') {
          for (const source of item.action?.sources ?? []) {
            const url = optionalString(source?.url)
            if (url === undefined) continue
            if (!byUrl.has(url)) byUrl.set(url, { url, ...(optionalString(source?.title) === undefined ? {} : { title: optionalString(source?.title) }) })
          }
        }
        if (item?.type === 'message') {
          for (const block of item.content ?? []) {
            for (const annotation of block?.annotations ?? []) {
              if (annotation?.type !== 'url_citation') continue
              const url = optionalString(annotation?.url)
              if (url === undefined || byUrl.has(url)) continue
              byUrl.set(url, { url, ...(optionalString(annotation?.title) === undefined ? {} : { title: optionalString(annotation?.title) }) })
            }
          }
        }
      }
      if (byUrl.size === 0) {
        throw new Error('openai: web_search returned no consultable source URLs')
      }
      return [...byUrl.values()].slice(0, settings.perSourceResults).map((source) => ({
        provider: 'openai',
        query,
        url: source.url,
        ...(source.title === undefined ? {} : { title: source.title }),
        snippet: '',
      }))
    },
  }
}

// --- ChatGPT subscription (Codex backend over oauth-providers) ---

/**
 * Extract consulted URLs from a Codex-backend SSE transcript: `open_page`
 * search actions (pages the model actually opened) plus `url_citation`
 * annotations (title-bearing). Generated prose is discarded — only the URLs
 * are evidence.
 */
export function extractCodexSources(sseText: string): { url: string; title?: string }[] {
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
    const record = frame as Record<string, unknown>
    // Streamed frames: a completed web_search_call with an open_page action.
    const item = record.item as Record<string, unknown> | undefined
    if (record.type === 'response.output_item.done' && item?.type === 'web_search_call') {
      const action = item.action as { type?: unknown; url?: unknown } | undefined
      if (action?.type === 'open_page') put(action.url, undefined)
    }
    // Streamed citation annotations.
    if (record.type === 'response.output_text.annotation.added') {
      const annotation = record.annotation as { type?: unknown; url?: unknown; title?: unknown } | undefined
      if (annotation?.type === 'url_citation') {
        put(annotation.url, annotation.title)
      }
    }
    // Terminal frame: re-walk the full output as a safety net.
    if (record.type === 'response.completed') {
      const output = (record.response as { output?: unknown[] } | undefined)?.output ?? []
      for (const entry of output) {
        const outputItem = entry as Record<string, unknown>
        if (outputItem?.type === 'message') {
          for (const block of (outputItem.content as { annotations?: unknown[] }[] | undefined) ?? []) {
            for (const annotation of block?.annotations ?? []) {
              const citation = annotation as { type?: unknown; url?: unknown; title?: unknown }
              if (citation?.type === 'url_citation') put(citation.url, citation.title)
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
        throw new Error('chatgpt: oauth-providers service unavailable or not signed in (Settings → OAuth Providers)')
      }
      const url = `${settings.chatgptApiBase.replace(/\/$/, '')}/responses`
      const body = JSON.stringify({
        model: settings.chatgptModel,
        instructions: 'Search the web and answer briefly, citing every source you used inline.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
        tools: [{ type: 'web_search' }],
        stream: true,
        store: false,
      })
      const response = await io.rawPost(url, body, {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        originator: 'dsh-search-integrator',
        authorization: `Bearer ${token.access}`,
        ...(token.accountId === undefined ? {} : { 'chatgpt-account-id': token.accountId }),
        'oai-product-sku': 'codex',
      }, signal)
      if (response.status !== 200) {
        throw new Error(`chatgpt codex: HTTP ${response.status}: ${response.text.slice(0, 200)}`)
      }
      const sources = extractCodexSources(response.text)
      if (sources.length === 0) {
        throw new Error('chatgpt: web_search consulted no citable source URLs')
      }
      return sources.slice(0, settings.perSourceResults).map((source) => ({
        provider: 'chatgpt',
        query,
        url: source.url,
        ...(source.title === undefined ? {} : { title: source.title }),
        snippet: '',
      }))
    },
  }
}

/**
 * Build the enabled adapters from a settings snapshot and resolved keys.
 *
 * @param settings - live settings snapshot.
 * @param keys - resolved API keys by provider id.
 * @param io - injectable network IO (tests script both halves).
 * @returns adapters plus `SourceFailure`s for enabled-but-unusable sources.
 */
export function buildAdapters(
  settings: SearchIntegratorSettings,
  keys: Readonly<Partial<Record<AdapterConfig['id'], string>>>,
  io: AdapterIo = { postJson, getJson, rawPost: fetchRawPost() },
): { adapters: SearchAdapter[]; failures: SourceFailure[] } {
  const adapters: SearchAdapter[] = []
  const failures: SourceFailure[] = []
  const wanted: AdapterConfig['id'][] = []
  if (settings.zhipuEnabled) wanted.push('zhipu')
  if (settings.tavilyEnabled) wanted.push('tavily')
  if (settings.exaEnabled) wanted.push('exa')
  if (settings.braveEnabled) wanted.push('brave')
  if (settings.openaiEnabled) wanted.push('openai')
  if (settings.chatgptEnabled && io.chatgptToken === undefined) {
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
    const config: AdapterConfig = { id, apiKey, settings, io }
    if (id === 'zhipu') adapters.push(createZhipuAdapter(config))
    if (id === 'tavily') adapters.push(createTavilyAdapter(config))
    if (id === 'exa') adapters.push(createExaAdapter(config))
    if (id === 'brave') adapters.push(createBraveAdapter(config))
    if (id === 'openai') adapters.push(createOpenaiAdapter(config))
  }
  // The ChatGPT source authenticates through the oauth-providers service,
  // not through an API-key credential reference.
  if (settings.chatgptEnabled && io.chatgptToken !== undefined) {
    adapters.push(createChatgptAdapter({ id: 'chatgpt', apiKey: '', settings, io }))
  }
  // One per-request deadline per provider call, independent of the shared
  // run budget: a hung source must fail into coverage.failed quickly instead
  // of eating the budget the other sources and the integrator share.
  // Generation-backed sources (web_search inside a model call) legitimately
  // take 10-30s+, so they get a multiple of the plain-SERP deadline.
  const generativeMs = settings.perRequestTimeoutMs * 4
  const bounded = adapters.map((adapter): SearchAdapter => {
    const deadlineMs = adapter.id === 'chatgpt' || adapter.id === 'openai' ? generativeMs : settings.perRequestTimeoutMs
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
