import { describe, expect, it } from 'vitest'
import { buildAdapters } from '../src/providers.js'
import type { AdapterIo } from '../src/providers.js'
import type { SearchIntegratorSettings } from '../src/settings.js'
import type { RawHit } from '../src/types.js'

function settings(overrides: Partial<SearchIntegratorSettings> = {}): SearchIntegratorSettings {
  return {
    zhipuEnabled: false,
    zhipuApiKeyRef: '',
    zhipuTransport: 'mcp',
    zhipuMcpUrl: '',
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
    integratorMaxTokens: 8192,
    followupRounds: 1,
    maxEvidence: 14,
    fetchTopN: 0,
    perSourceResults: 5,
    excerptChars: 1600,
    totalBudgetMs: 110_000,
    perRequestTimeoutMs: 12_000,
    maxRenderChars: 7000,
    auditEnabled: true,
    ...overrides,
  }
}

/** Scripted IO: record calls, answer per-kind from queues. */
function fakeIo(responses: {
  get?: unknown
  post?: unknown
} & Record<string, unknown>) {
  const calls: { kind: 'get' | 'post'; url: string; body?: unknown; headers: Record<string, string> }[] = []
  const io = {
    async postJson(url: string, body: unknown, headers: Record<string, string>) {
      calls.push({ kind: 'post', url, body, headers })
      if (responses.post instanceof Error) throw responses.post
      return responses.post
    },
    async getJson(url: string, headers: Record<string, string>) {
      calls.push({ kind: 'get', url, headers })
      if (responses.get instanceof Error) throw responses.get
      return responses.get
    },
    async rawPost() {
      throw new Error('rawPost not expected')
    },
  } as unknown as AdapterIo
  return { io, calls }
}

const signal = () => new AbortController().signal

describe('brave adapter', () => {
  it('maps web.results into hits with extra snippets as content', async () => {
    const { io, calls } = fakeIo({
      get: { web: { results: [
        { title: 'Brave Result', url: 'https://b.example/1', description: 'main snippet', age: '2 days ago', extra_snippets: ['extra one', 42, 'extra two'] },
      ] } },
    })
    const { adapters } = buildAdapters(settings({ braveEnabled: true }), { brave: 'k' }, io)
    const hits = await adapters[0]?.search('q', signal())
    expect(hits).toEqual([{
      provider: 'brave',
      query: 'q',
      url: 'https://b.example/1',
      title: 'Brave Result',
      snippet: 'main snippet',
      publishedAt: '2 days ago',
      content: 'extra one\nextra two',
    }] as RawHit[])
    expect(calls[0]?.kind).toBe('get')
    expect(calls[0]?.url).toContain('https://api.search.brave.com/res/v1/web/search?q=q&count=5')
    expect(calls[0]?.headers['x-subscription-token']).toBe('k')
  })

  it('fails when a result misses its url', async () => {
    const { io } = fakeIo({ get: { web: { results: [{ title: 'no url' }] } } })
    const { adapters } = buildAdapters(settings({ braveEnabled: true }), { brave: 'k' }, io)
    await expect(adapters[0]?.search('q', signal())).rejects.toThrow(/brave web.results/)
  })
})

describe('openai adapter', () => {
  it('collects consulted source urls and citation annotations, dropping generated prose', async () => {
    const { io, calls } = fakeIo({
      post: { output: [
        { type: 'web_search_call', action: { sources: [
          { url: 'https://o.example/1', title: 'One' },
          { url: 'https://o.example/2' }, // no title
        ] } },
        { type: 'message', content: [{ annotations: [
          { type: 'url_citation', url: 'https://o.example/1', title: 'One (dup)' },
          { type: 'url_citation', url: 'https://o.example/3', title: 'Three' },
        ] }] },
      ] },
    })
    const { adapters } = buildAdapters(settings({ openaiEnabled: true }), { openai: 'k' }, io)
    const hits = await adapters[0]?.search('q', signal())
    expect(hits?.map((hit) => hit.url)).toEqual(['https://o.example/1', 'https://o.example/2', 'https://o.example/3'])
    expect(hits?.every((hit) => hit.snippet === '')).toBe(true) // generated text is never evidence
    const body = calls[0]?.body as Record<string, unknown>
    expect(body.model).toBe('gpt-5.5')
    expect(body.tool_choice).toBe('required')
    expect(body.include).toEqual(['web_search_call.action.sources'])
    expect(calls[0]?.headers.authorization).toBe('Bearer k')
  })

  it('omits the reasoning block when the effort is empty (non-reasoning models)', async () => {
    const { io, calls } = fakeIo({
      post: { output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://o.example/1' }] } }] },
    })
    const { adapters } = buildAdapters(settings({ openaiEnabled: true, openaiReasoningEffort: '' }), { openai: 'k' }, io)
    await adapters[0]?.search('q', signal())
    const body = calls[0]?.body as Record<string, unknown>
    expect('reasoning' in body).toBe(false)
  })

  it('fails explicitly when the tool consulted no sources', async () => {
    const { io } = fakeIo({ post: { output: [{ type: 'message', content: [{ annotations: [] }] }] } })
    const { adapters } = buildAdapters(settings({ openaiEnabled: true }), { openai: 'k' }, io)
    await expect(adapters[0]?.search('q', signal())).rejects.toThrow(/no consultable source URLs/)
  })

  it('caps hits at perSourceResults', async () => {
    const sources = Array.from({ length: 8 }, (_, i) => ({ url: `https://o.example/${i}` }))
    const { io } = fakeIo({ post: { output: [{ type: 'web_search_call', action: { sources } }] } })
    const { adapters } = buildAdapters(settings({ openaiEnabled: true }), { openai: 'k' }, io)
    const hits = await adapters[0]?.search('q', signal())
    expect(hits).toHaveLength(5)
  })
})

describe('chatgpt codex adapter', () => {
  const sse = (frames: unknown[]) =>
    frames.map((frame) => `data: ${JSON.stringify(frame)}`).join('\n\n')

  function chatgptIo(sseText: string, token?: { access: string; accountId?: string }) {
    const posts: { url: string; body: unknown; headers: Record<string, string> }[] = []
    const io = {
      async postJson() {
        throw new Error('postJson not expected')
      },
      async getJson() {
        throw new Error('getJson not expected')
      },
      async rawPost(url: string, body: string, headers: Record<string, string>) {
        posts.push({ url, body: JSON.parse(body), headers })
        return { status: 200, contentType: 'text/event-stream', text: sseText, headers: {} }
      },
      ...(token === undefined ? {} : { chatgptToken: async () => token }),
    } as unknown as AdapterIo
    return { io, posts }
  }

  it('extracts open_page urls and url_citation annotations from the SSE stream', async () => {
    const text = sse([
      { type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'search', query: 'q' } } },
      { type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'open_page', url: 'https://c.example/opened' } } },
      { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://c.example/cited', title: 'Cited' } },
      { type: 'response.completed', response: { output: [
        { type: 'web_search_call', action: { type: 'open_page', url: 'https://c.example/opened' } },
        { type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://c.example/cited', title: 'Cited' }] }] },
      ] } },
    ])
    const { io, posts } = chatgptIo(text, { access: 'tok-1', accountId: 'acct-9' })
    const { adapters } = buildAdapters(settings({ chatgptEnabled: true }), {}, io)
    const hits = await adapters[0]?.search('q', signal())
    expect(hits?.map((hit) => hit.url).sort()).toEqual(['https://c.example/cited', 'https://c.example/opened'])
    expect(hits?.every((hit) => hit.snippet === '')).toBe(true)
    expect(posts[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(posts[0]?.headers.authorization).toBe('Bearer tok-1')
    expect(posts[0]?.headers['chatgpt-account-id']).toBe('acct-9')
    expect(posts[0]?.headers['oai-product-sku']).toBe('codex')
    const body = posts[0]?.body as { tools: { type: string }[]; stream: boolean; store: boolean }
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
  })

  it('fails explicitly when no citable sources came back', async () => {
    const { io } = chatgptIo(sse([{ type: 'response.completed', response: { output: [] } }]), { access: 'tok' })
    const { adapters } = buildAdapters(settings({ chatgptEnabled: true }), {}, io)
    await expect(adapters[0]?.search('q', signal())).rejects.toThrow(/no citable source/)
  })

  it('fails when the oauth token cannot be resolved (signed out)', async () => {
    const io = {
      async postJson() {
        throw new Error('postJson not expected')
      },
      async getJson() {
        throw new Error('getJson not expected')
      },
      async rawPost() {
        throw new Error('rawPost not expected')
      },
      chatgptToken: async () => undefined,
    } as unknown as AdapterIo
    const { adapters } = buildAdapters(settings({ chatgptEnabled: true }), {}, io)
    await expect(adapters[0]?.search('q', signal())).rejects.toThrow(/oauth-providers/)
  })

  it('records a config failure when the oauthProviders service is not mounted', () => {
    const io = {} as AdapterIo
    const { adapters, failures } = buildAdapters(settings({ chatgptEnabled: true }), {}, io)
    expect(adapters).toHaveLength(0)
    expect(failures[0]?.source).toBe('chatgpt')
    expect(failures[0]?.reason).toContain('oauth-providers')
  })
})
