import { describe, expect, it } from 'vitest'
import { buildDigest, buildEvidence } from '../src/evidence.js'
import { htmlToExcerpt } from '../src/fetch-page.js'
import { runResearch } from '../src/pipeline.js'
import { createFakeAdapter } from '../src/providers.js'
import type { SearchAdapter } from '../src/providers.js'
import type { SearchIntegratorSettings } from '../src/settings.js'
import type { RawHit } from '../src/types.js'

function settings(overrides: Partial<SearchIntegratorSettings> = {}): SearchIntegratorSettings {
  return {
    zhipuEnabled: false, zhipuApiKeyRef: '', zhipuTransport: 'mcp', zhipuMcpUrl: '', zhipuMcpTool: 'web_search',
    zhipuApiBase: '', zhipuEngine: 'search_std',
    tavilyEnabled: false, tavilyApiKeyRef: '', tavilyApiBase: '', tavilySearchDepth: 'basic', tavilyIncludeRaw: false,
    braveEnabled: false, braveApiKeyRef: '', braveApiBase: '',
    openaiEnabled: false, openaiApiKeyRef: '', openaiApiBase: '', openaiModel: 'gpt-5.5',
    openaiSearchContextSize: 'low', openaiReasoningEffort: 'low',
    chatgptEnabled: false, chatgptModel: 'gpt-5.5', chatgptApiBase: '',
    exaEnabled: false, exaApiKeyRef: '', exaApiBase: '',
    integratorProvider: '', integratorModel: '', integratorMaxTokens: 8192,
    followupRounds: 0, maxEvidence: 14, fetchTopN: 2, perSourceResults: 8,
    excerptChars: 1600, totalBudgetMs: 110_000, perRequestTimeoutMs: 12_000, maxRenderChars: 7000,
    auditEnabled: false,
    ...overrides,
  }
}

describe('htmlToExcerpt', () => {
  it('strips markup, decodes entities, and keeps line structure', () => {
    const html = '<html><head><style>.x{color:red}</style></head><body>' +
      '<script>evil()</script>' +
      '<h1>Title &amp; more</h1><p>First &lt;para&gt;</p><div>Second<br>line&nbsp;here</div>' +
      '<!-- comment --><footer>foot</footer></body></html>'
    const text = htmlToExcerpt(html, 200)
    expect(text).toContain('Title & more')
    expect(text).toContain('First <para>')
    expect(text).toContain('line here')
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('.x')
    expect(text).not.toContain('foot')
  })

  it('caps the excerpt with an ellipsis', () => {
    expect(htmlToExcerpt(`<p>${'x'.repeat(500)}</p>`, 100).length).toBeLessThanOrEqual(101)
  })
})

describe('evidence dissent protection', () => {
  it('re-admits one dropped entry from an unseen domain', () => {
    const hits: RawHit[] = [
      { provider: 'exa', query: 'q', url: 'https://a.example/1', snippet: 'alpha', title: 'A1' },
      { provider: 'exa', query: 'q', url: 'https://a.example/2', snippet: 'alpha', title: 'A2' },
      { provider: 'exa', query: 'q', url: 'https://a.example/3', snippet: 'alpha', title: 'A3' },
      { provider: 'zhipu', query: 'q', url: 'https://lone.example/counter', snippet: 'alpha alpha alpha alpha counter', title: 'Lone' },
    ]
    // All a.example entries agree (multi-query provenance scores higher); the
    // lone dissenting domain would be sliced off by cap=3 but is re-admitted.
    const evidence = buildEvidence(hits, ['alpha'], 3)
    expect(evidence).toHaveLength(4)
    expect(evidence[evidence.length - 1]?.url).toBe('https://lone.example/counter')
  })
})

describe('digest fair-share budget', () => {
  it('no single verbose source starves later sources to URL-only', () => {
    const evidence = buildEvidence([
      { provider: 'exa', query: 'q', url: 'https://long.example/1', snippet: 'y'.repeat(1400), title: 'L' },
      { provider: 'exa', query: 'q', url: 'https://b.example/2', snippet: 'b'.repeat(300), title: 'B' },
      { provider: 'exa', query: 'q', url: 'https://c.example/3', snippet: 'c'.repeat(300), title: 'C' },
    ], [], 14)
    const digest = buildDigest(evidence, 1600, 2400)
    expect(digest).toContain('b'.repeat(50))
    expect(digest).toContain('c'.repeat(50))
  })
})

describe('pipeline page enrichment', () => {
  const integration = JSON.stringify({
    summary: 'ok', points: [{ text: 't', status: 'supported', sources: [1] }],
    unknowns: [], followup: { needed: false, queries: [] },
  })

  it('fetches body excerpts for thin top sources and keeps them on failure', async () => {
    const adapters: SearchAdapter[] = [
      createFakeAdapter('exa', () => [
        { provider: 'exa', query: 'q', url: 'https://thin.example/1', snippet: 'short', title: 'Thin' },
        { provider: 'exa', query: 'q', url: 'https://rich.example/2', snippet: 'z'.repeat(800), title: 'Rich' },
      ]),
    ]
    const fetched: string[] = []
    const llmCalls: string[] = []
    const result = await runResearch({
      adapters,
      configFailures: [],
      llm: {
        async call(req) {
          llmCalls.push(req.user)
          return { ok: true, text: integration, finishKind: 'stop' }
        },
      },
      audit: { async save() { return undefined } },
      settings: settings({ fetchTopN: 2 }),
      fetchPage: async (url) => {
        fetched.push(url)
        if (url.includes('thin.example')) {
          return { contentType: 'text/html', body: `<html><body><p>${'body '.repeat(200)}</p></body></html>` }
        }
        return undefined // rich source fetch fails silently
      },
    }, { question: 'q', queries: ['q'] }, new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(fetched).toEqual(['https://thin.example/1'])
    // The digest the integrator saw carries the fetched body, not the snippet.
    expect(llmCalls[0]).toContain('body body body')
  })

  it('skips fetching when fetchTopN is zero', async () => {
    const fetched: string[] = []
    const result = await runResearch({
      adapters: [createFakeAdapter('exa', () => [
        { provider: 'exa', query: 'q', url: 'https://thin.example/1', snippet: 'short' },
      ])],
      configFailures: [],
      llm: {
        async call() {
          return { ok: true, text: integration, finishKind: 'stop' }
        },
      },
      audit: { async save() { return undefined } },
      settings: settings({ fetchTopN: 0 }),
      fetchPage: async (url) => {
        fetched.push(url)
        return undefined
      },
    }, { question: 'q', queries: ['q'] }, new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(fetched).toEqual([])
  })
})
