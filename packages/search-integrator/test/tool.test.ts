import { describe, expect, it } from 'vitest'
import { makeResearchTool } from '../src/tool.js'
import type { ToolHost } from '../src/tool.js'
import type { SearchIntegratorSettings } from '../src/settings.js'

function settings(overrides: Partial<SearchIntegratorSettings> = {}): SearchIntegratorSettings {
  return {
    zhipuEnabled: false,
    zhipuApiKeyRef: '',
    zhipuTransport: 'mcp' as const,
    zhipuMcpUrl: 'https://mcp.test/web-search',
    zhipuMcpTool: 'web_search',
    zhipuApiBase: '',
    zhipuEngine: 'search_std',
    tavilyEnabled: true,
    tavilyApiKeyRef: 'TAVILY_API_KEY',
    tavilyApiBase: 'https://api.tavily.com',
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
    integratorProvider: 'prov',
    integratorModel: 'fast',
    integratorMaxTokens: 2048,
    followupRounds: 0,
    maxEvidence: 14,
    fetchTopN: 0,
    perSourceResults: 8,
    excerptChars: 1600,
    totalBudgetMs: 30_000,
    perRequestTimeoutMs: 12_000,
    maxRenderChars: 7000,
    auditEnabled: false,
    ...overrides,
  }
}

function fakeHost(overrides: Partial<ToolHost> = {}): ToolHost {
  const integration = JSON.stringify({
    summary: 'Tool-level answer.',
    points: [{ text: 'fact', status: 'supported', sources: [1] }],
    unknowns: [],
    followup: { needed: false, queries: [] },
  })
  const fakePostJson: ToolHost['postJson'] = async () => ({
    results: [
      {
        title: 'A',
        url: 'https://a.example/1',
        content: 'evidence one',
        published_date: '2026-01-02',
      },
    ],
  })
  return {
    readSettings: () => settings(),
    resolveCredential: async () => 'test-key',
    llmFor: () => ({
      async call() {
        return { ok: true, text: integration, finishKind: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }),
    auditFor: () => ({
      async save() {
        return undefined
      },
    }),
    postJson: fakePostJson,
    getJson: (async () => {
      throw new Error('getJson not expected in this test')
    }) as never,
    rawPost: (async () => {
      throw new Error('rawPost not expected in this test')
    }) as never,
    chatgptToken: (async () => {
      throw new Error('chatgptToken not expected in this test')
    }) as never,
    warn: () => {},
    ...overrides,
  }
}

function execStub(signal = new AbortController().signal) {
  return {
    callId: 'call_1',
    rootCallId: 'call_1',
    name: 'web_research',
    arguments: {},
    signal,
    agent: { id: 'session-1' },
    deferContext: () => {},
    concludeTurn: () => {},
  } as never
}

describe('makeResearchTool', () => {
  it('registers the declared surface and executes the pipeline', async () => {
    const tool = makeResearchTool(fakeHost(), { name: 'web_research', timeoutMs: 5000 })
    expect(tool.name).toBe('web_research')
    expect(tool.timeoutMs).toBe(5000)
    const value = await tool.execute({ question: 'the question', queries: ['q'] }, execStub()) as Record<string, unknown>
    expect(value.status).toBe('ok')
    expect(value.summary).toBe('Tool-level answer.')
    const sources = value.sources as { id: number; url: string; snippet?: string }[]
    expect(sources[0]?.url).toBe('https://a.example/1')
  })

  it('rejects an empty question', async () => {
    const tool = makeResearchTool(fakeHost(), { name: 'web_research', timeoutMs: 5000 })
    await expect(tool.execute({ question: '   ' }, execStub())).rejects.toThrow('non-empty')
  })

  it('degrades to a config failure when credential resolution throws (not crash)', async () => {
    const host = fakeHost({
      resolveCredential: async () => {
        throw new Error('credential store exploded')
      },
    })
    const tool = makeResearchTool(host, { name: 'web_research', timeoutMs: 5000 })
    const value = await tool.execute({ question: 'q' }, execStub()) as Record<string, unknown>
    expect(value.status).toBe('failed')
    expect(String(value.summary)).toContain('no search sources available')
  })

  it('returns an explicit failed value when wiring crashes (non-abort)', async () => {
    const host = fakeHost({
      llmFor: () => {
        throw new Error('port construction exploded')
      },
    })
    const tool = makeResearchTool(host, { name: 'web_research', timeoutMs: 5000 })
    const value = await tool.execute({ question: 'q' }, execStub()) as Record<string, unknown>
    expect(value.status).toBe('failed')
    expect(String(value.summary)).toContain('research run crashed')
  })

  it('propagates abort instead of masking it as a failed value', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = makeResearchTool(fakeHost(), { name: 'web_research', timeoutMs: 5000 })
    await expect(tool.execute({ question: 'q' }, execStub(controller.signal))).rejects.toThrow()
  })

  it('renders a compact text block and presentation meta from the value', async () => {
    const tool = makeResearchTool(fakeHost(), { name: 'web_research', timeoutMs: 5000 })
    const value = await tool.execute({ question: 'the question', queries: ['q'] }, execStub()) as never
    const blocks = tool.output.render({ question: 'the question' } as never, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('Tool-level answer.')
    expect(text).toContain('Sources:')
    expect(text).toContain('untrusted data')
    const meta = tool.output.presentationMeta?.({ question: 'x' } as never, value) as Record<string, unknown>
    expect(meta.status).toBe('ok')
    expect(meta.searched).toEqual(['tavily'])
  })

  it('renders the audit locator (not just the backend hint)', async () => {
    const host = fakeHost({
      readSettings: () => settings({ auditEnabled: true }),
      auditFor: () => ({
        async save() {
          return { locator: '/tmp/dsh-spill-x/session-1/audit.txt', retrievalHint: 'Use read with offset/limit, or grep this path to search within it.', bytes: 1234 }
        },
      }),
    })
    const tool = makeResearchTool(host, { name: 'web_research', timeoutMs: 5000 })
    const value = await tool.execute({ question: 'the question', queries: ['q'] }, execStub()) as never
    const text = (tool.output.render({ question: 'x' } as never, value)[0] as { text: string }).text
    expect(text).toContain('Audit: /tmp/dsh-spill-x/session-1/audit.txt')
    const meta = tool.output.presentationMeta?.({ question: 'x' } as never, value) as { audit?: { locator: string } }
    expect(meta.audit?.locator).toBe('/tmp/dsh-spill-x/session-1/audit.txt')
  })

  it('defaults to degraded when no integrator route is configured', async () => {
    const host = fakeHost({
      readSettings: () => settings({ integratorProvider: '', integratorModel: '' }),
      llmFor: () => undefined,
    })
    const tool = makeResearchTool(host, { name: 'web_research', timeoutMs: 5000 })
    const value = await tool.execute({ question: 'q', queries: ['q'] }, execStub()) as Record<string, unknown>
    expect(value.status).toBe('degraded')
    expect(String(value.degradedReason)).toContain('integrator model not configured')
  })

  it('does not run when no source credential resolves', async () => {
    const host = fakeHost({ resolveCredential: async () => undefined })
    const tool = makeResearchTool(host, { name: 'web_research', timeoutMs: 5000 })
    const value = await tool.execute({ question: 'q' }, execStub()) as Record<string, unknown>
    expect(value.status).toBe('failed')
    expect(String(value.summary)).toContain('no search sources available')
  })
})
