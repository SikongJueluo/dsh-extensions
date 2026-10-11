import { describe, expect, it } from 'vitest'
import { McpTransportError, mcpCallTool, parseRpcBody } from '../src/mcp.js'
import type { RawPost } from '../src/mcp.js'
import { buildAdapters } from '../src/providers.js'
import type { SearchIntegratorSettings } from '../src/settings.js'

interface ScriptedExchange {
  readonly status?: number
  readonly contentType?: string
  readonly body: string
  readonly responseHeaders?: Record<string, string>
}

/** A RawPost that pops scripted exchanges and records requests. */
function fakePost(script: ScriptedExchange[]) {
  const requests: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const queue = [...script]
  const post: RawPost = async (url, body, headers) => {
    requests.push({ url, body: JSON.parse(body), headers })
    const next = queue.shift()
    if (next === undefined) throw new Error('script exhausted')
    return {
      status: next.status ?? 200,
      contentType: next.contentType ?? 'application/json',
      text: next.body,
      headers: next.responseHeaders ?? {},
    }
  }
  return { post, requests }
}

const searchResult = {
  search_result: [
    { title: 'T', link: 'https://a.example/1', content: 'snippet', publish_date: '2026-01-01' },
  ],
}

const okCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  result: { content: [{ type: 'text', text: JSON.stringify(searchResult) }] },
})

describe('parseRpcBody', () => {
  it('parses plain JSON', () => {
    expect(parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}').id).toBe(1)
  })

  it('parses the first SSE data frame', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"a":1}}\n\ndata: {"jsonrpc":"2.0","id":3}\n'
    expect(parseRpcBody('text/event-stream', sse).id).toBe(2)
  })

  it('throws on an SSE body without parsable frames', () => {
    expect(() => parseRpcBody('text/event-stream', 'event: message\ndata: not-json\n'))
      .toThrow(McpTransportError)
  })
})

describe('mcpCallTool', () => {
  it('runs initialize → initialized → tools/call and parses the text payload', async () => {
    const { post, requests } = fakePost([
      { body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}', responseHeaders: { 'mcp-session-id': 'sess-1' } },
      { status: 202, body: '' },
      { body: okCall },
    ])
    const result = await mcpCallTool(post, 'https://mcp.test/x', 'key-1', 'web_search', { search_query: 'q' }, new AbortController().signal)
    expect(result.text).toContain('search_result')
    const methods = requests.map((request) => (request.body as { method?: string }).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    // Bearer auth + session id ride the tool call.
    expect(requests[0]?.headers.authorization).toBe('Bearer key-1')
    expect(requests[2]?.headers['mcp-session-id']).toBe('sess-1')
    const params = (requests[2]?.body as { params?: { name?: string } }).params
    expect(params?.name).toBe('web_search')
  })

  it('discovers the tool name via tools/list when the call is rejected', async () => {
    const { post, requests } = fakePost([
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}', responseHeaders: { 'Mcp-Session-Id': 's' } },
      { status: 202, body: '' },
      { body: '{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Unknown tool: web_search"}}' },
      { body: '{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"web_search_pro"}]}}' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: '{}' }] } }) },
    ])
    const result = await mcpCallTool(post, 'https://mcp.test/discover', 'k', 'web_search', {}, new AbortController().signal)
    expect(result.text).toBe('{}')
    expect(requests).toHaveLength(5)
    const retry = (requests[4]?.body as { params?: { name?: string } }).params
    expect(retry?.name).toBe('web_search_pro')
  })

  it('surfaces broker-level plain errors (auth) as transport errors', async () => {
    const { post } = fakePost([
      { status: 401, body: '{"code":401,"msg":"令牌已过期或验证不正确","success":false}' },
    ])
    await expect(mcpCallTool(post, 'https://mcp.test/x', 'bad', 'web_search', {}, new AbortController().signal))
      .rejects.toThrow(/401/)
  })

  it('surfaces JSON-RPC errors from the tool call', async () => {
    const { post } = fakePost([
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}' },
      { status: 202, body: '' },
      { body: '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"quota exceeded"}}' },
    ])
    await expect(mcpCallTool(post, 'https://mcp.test/x', 'k', 'web_search', {}, new AbortController().signal))
      .rejects.toThrow(/quota exceeded/)
  })

  it('accepts SSE-encoded tool results', async () => {
    const sse = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'hello' }] } })}\n\n`
    const { post } = fakePost([
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}' },
      { status: 202, body: '' },
      { contentType: 'text/event-stream', body: sse },
    ])
    const result = await mcpCallTool(post, 'https://mcp.test/x', 'k', 'web_search', {}, new AbortController().signal)
    expect(result.text).toBe('hello')
  })
})

describe('zhipu adapter over MCP', () => {
  const settings = {
    zhipuEnabled: true,
    zhipuApiKeyRef: 'ZHIPU_API_KEY',
    zhipuTransport: 'mcp',
    zhipuMcpUrl: 'https://mcp.test/web-search',
    zhipuMcpTool: 'web_search',
    zhipuApiBase: '',
    zhipuEngine: 'search_std',
    tavilyEnabled: false,
    tavilyApiKeyRef: '',
    tavilyApiBase: '',
    tavilySearchDepth: 'basic',
    tavilyIncludeRaw: false,
    braveEnabled: false,
    braveApiKeyRef: 'BRAVE_API_KEY',
    braveApiBase: 'https://api.search.brave.com/res/v1',
    openaiEnabled: false,
    openaiApiKeyRef: 'OPENAI_API_KEY',
    openaiApiBase: 'https://api.openai.com/v1',
    openaiModel: 'gpt-5.5',
    openaiSearchContextSize: 'low',
    openaiReasoningEffort: 'low',
    chatgptEnabled: false,
    chatgptModel: 'gpt-5.5',
    chatgptApiBase: 'https://chatgpt.com/backend-api/codex',
    exaEnabled: false,
    exaApiKeyRef: '',
    exaApiBase: '',
    integratorProvider: '',
    integratorModel: '',
    integratorMaxTokens: 2048,
    followupRounds: 1,
    maxEvidence: 14,
    fetchTopN: 0,
    perSourceResults: 8,
    excerptChars: 1600,
    totalBudgetMs: 110_000,
    perRequestTimeoutMs: 12_000,
    maxRenderChars: 7000,
    auditEnabled: true,
  } satisfies SearchIntegratorSettings

  it('normalizes the broker payload into raw hits', async () => {
    const { post, requests } = fakePost([
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}', responseHeaders: { 'mcp-session-id': 's' } },
      { status: 202, body: '' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { structuredContent: searchResult } }) },
    ])
    const { adapters } = buildAdapters(settings, { zhipu: 'k' }, {
      postJson: (async () => {
        throw new Error('postJson not expected')
      }) as never,
      getJson: (async () => {
        throw new Error('getJson not expected')
      }) as never,
      rawPost: post,
    })
    const hits = await adapters[0]?.search('查询', new AbortController().signal)
    expect(hits).toEqual([{
      provider: 'zhipu',
      query: '查询',
      url: 'https://a.example/1',
      title: 'T',
      snippet: 'snippet',
      publishedAt: '2026-01-01',
    }])
    const call = requests[2]?.body as { params?: { arguments?: { search_engine?: string; count?: number } } }
    expect(call.params?.arguments?.search_engine).toBe('search_std')
    expect(call.params?.arguments?.count).toBe(8)
  })

  it('parses the double-encoded webSearchPrime array text', async () => {
    const hitsJson = JSON.stringify(searchResult.search_result)
    const { post } = fakePost([
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}', responseHeaders: { 'mcp-session-id': 's' } },
      { status: 202, body: '' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify(hitsJson) }] } }) },
    ])
    const { adapters } = buildAdapters(settings, { zhipu: 'k' }, {
      postJson: (async () => {
        throw new Error('postJson not expected')
      }) as never,
      getJson: (async () => {
        throw new Error('getJson not expected')
      }) as never,
      rawPost: post,
    })
    const hits = await adapters[0]?.search('q', new AbortController().signal)
    expect(hits?.[0]?.url).toBe('https://a.example/1')
  })

  it('fails fast on a broker auth error', async () => {
    const { post } = fakePost([
      { status: 401, body: '{"code":401,"msg":"令牌已过期或验证不正确","success":false}' },
    ])
    const { adapters } = buildAdapters(settings, { zhipu: 'bad' }, {
      postJson: (async () => {
        throw new Error('postJson not expected')
      }) as never,
      getJson: (async () => {
        throw new Error('getJson not expected')
      }) as never,
      rawPost: post,
    })
    await expect(adapters[0]?.search('q', new AbortController().signal)).rejects.toThrow(/401/)
  })
})
