import { describe, expect, it } from 'vitest'
import { runResearch } from '../src/pipeline.js'
import type { PipelineDeps } from '../src/pipeline.js'
import { createFakeAdapter } from '../src/providers.js'
import type { SearchAdapter } from '../src/providers.js'
import { renderResearch } from '../src/render.js'
import type { SearchIntegratorSettings } from '../src/settings.js'
import type { AuditRef, RawHit } from '../src/types.js'

function baseSettings(overrides: Partial<SearchIntegratorSettings> = {}): SearchIntegratorSettings {
  return {
    zhipuEnabled: false,
    zhipuApiKeyRef: 'ZHIPU_API_KEY',
    zhipuTransport: 'mcp' as const,
    zhipuMcpUrl: 'https://mcp.test/web-search',
    zhipuMcpTool: 'web_search',
    zhipuApiBase: 'https://open.bigmodel.cn/api/paas/v4',
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
    exaEnabled: true,
    exaApiKeyRef: 'EXA_API_KEY',
    exaApiBase: 'https://api.exa.ai',
    integratorProvider: 'prov',
    integratorModel: 'fast',
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
    ...overrides,
  }
}

function hit(provider: string, url: string, snippet: string, query = 'q'): RawHit {
  return { provider, query, url, snippet, title: `title ${url}` }
}

/** Scripted integrator that answers with a fixed contract JSON. */
function integrationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Integrated answer.',
    points: [{ text: 'Shared fact', status: 'supported', sources: [1] }],
    unknowns: [],
    followup: { needed: false, queries: [] },
    ...overrides,
  })
}

function fakeLlmPort(responses: (string | { error: string })[], usage = { inputTokens: 5, outputTokens: 3 }) {
  const calls: { system: string; user: string }[] = []
  const queue = [...responses]
  return {
    calls,
    port: {
      async call(req: { system: string; user: string }) {
        calls.push({ system: req.system, user: req.user })
        const next = queue.shift()
        if (next === undefined) throw new Error('fake llm exhausted')
        if (typeof next !== 'string') {
          return { ok: false, text: '', finishKind: 'error', error: next.error }
        }
        return { ok: true, text: next, finishKind: 'stop', usage }
      },
    } as PipelineDeps['llm'],
  }
}

function recordingAudit() {
  const payloads: string[] = []
  return {
    payloads,
    port: {
      async save(payload: string): Promise<AuditRef> {
        payloads.push(payload)
        return { locator: 'spill://audit-1', retrievalHint: 'read spill://audit-1', bytes: payload.length }
      },
    } as PipelineDeps['audit'],
  }
}

function twoSources(): SearchAdapter[] {
  return [
    createFakeAdapter('tavily', () => [
      hit('tavily', 'https://shared.example/one', 'shared fact from tavily'),
      hit('tavily', 'https://tavily.example/only', 'tavily-only hit'),
    ]),
    createFakeAdapter('exa', () => [
      hit('exa', 'https://shared.example/one?utm_source=share', 'shared fact from exa, longer'),
      hit('exa', 'https://exa.example/only', 'exa-only hit'),
    ]),
  ]
}

async function run(
  deps: Partial<PipelineDeps> & { adapters: SearchAdapter[] },
  args: { question: string; queries?: string[] },
  signal: AbortSignal = new AbortController().signal,
): Promise<{ result: Awaited<ReturnType<typeof runResearch>>; audit: ReturnType<typeof recordingAudit> }> {
  const audit = recordingAudit()
  const { audit: _ignored, ...rest } = deps
  void _ignored
  const result = await runResearch(
    {
      configFailures: [],
      settings: baseSettings(),
      ...rest,
      audit: audit.port,
    } as PipelineDeps,
    args,
    signal,
  )
  return { result, audit }
}

describe('runResearch', () => {
  it('integrates across sources, dedups the shared url, cites merged provenance', async () => {
    const llm = fakeLlmPort([integrationJson()])
    const { result } = await run({ adapters: twoSources(), llm: llm.port }, { question: 'what is the shared fact?', queries: ['shared fact'] })
    expect(result.status).toBe('ok')
    expect(result.summary).toBe('Integrated answer.')
    const shared = result.sources.find((source) => source.url === 'https://shared.example/one')
    expect(shared).toBeDefined()
    expect([...shared?.providers ?? []].sort()).toEqual(['exa', 'tavily'])
    expect([...result.coverage.searched].sort()).toEqual(['exa', 'tavily'])
    expect(result.coverage.failed).toEqual([])
    expect(result.coverage.resultsFound).toBe(4)
    expect(result.coverage.evidenceCount).toBeLessThanOrEqual(result.coverage.resultsFound)
  })

  it('saves the audit artifact and returns its retrieval pointer', async () => {
    const llm = fakeLlmPort([integrationJson()])
    const { result, audit } = await run({ adapters: twoSources(), llm: llm.port }, { question: 'q', queries: ['q'] })
    expect(audit.payloads).toHaveLength(1)
    const payload = JSON.parse(audit.payloads[0] ?? '{}')
    expect(payload.question).toBe('q')
    expect(payload.rounds[0].hitCount).toBe(4)
    expect(payload.llmRawOutputs).toHaveLength(1)
    expect(result.audit?.locator).toBe('spill://audit-1')
  })

  it('continues when one source fails, recording the gap', async () => {
    const failing = createFakeAdapter('exa', () => {
      throw new Error('HTTP 429: rate limited')
    })
    const llm = fakeLlmPort([integrationJson()])
    const { result } = await run({
      adapters: [createFakeAdapter('tavily', () => [hit('tavily', 'https://a.example/1', 's')]), failing],
      llm: llm.port,
    }, { question: 'q', queries: ['q'] })
    expect(result.status).toBe('ok')
    expect(result.coverage.failed).toEqual([{ source: 'exa', reason: expect.stringContaining('429') }])
    expect(result.coverage.searched).toEqual(['tavily'])
  })

  it('fails explicitly when every source fails', async () => {
    const { result } = await run({
      adapters: [
        createFakeAdapter('tavily', () => {
          throw new Error('HTTP 500: boom')
        }),
        createFakeAdapter('exa', () => {
          throw new Error('network down')
        }),
      ],
      llm: fakeLlmPort([integrationJson()]).port,
    }, { question: 'q' })
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('no search results')
    expect(result.sources).toEqual([])
    expect(result.coverage.failed.map((f) => f.source).sort()).toEqual(['exa', 'tavily'])
  })

  it('fails when sources return nothing', async () => {
    const { result } = await run({
      adapters: [createFakeAdapter('tavily', () => [])],
      llm: fakeLlmPort([integrationJson()]).port,
    }, { question: 'q' })
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('no search results')
  })

  it('fails when no source is usable at all (config failures)', async () => {
    const { result } = await run({
      adapters: [],
      configFailures: [{ source: 'zhipu', reason: 'API key not configured (credential reference resolves to nothing)' }],
      llm: fakeLlmPort([integrationJson()]).port,
    }, { question: 'q' })
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('no search sources available')
    expect(result.coverage.failed[0]?.source).toBe('zhipu')
  })

  it('degrades to a labeled digest when no integrator is configured', async () => {
    const { result } = await run({
      adapters: twoSources(),
      llm: undefined,
    }, { question: 'q' })
    expect(result.status).toBe('degraded')
    expect(result.degradedReason).toContain('integrator model not configured')
    expect(result.points).toEqual([])
    expect(result.sources[0]?.snippet).toBeDefined()
    const text = renderResearch(result, 7000)
    expect(text).toContain('UNINTEGRATED RESULTS')
    expect(text).toContain('NOT verified or synthesized')
  })

  it('degrades (not crashes) when integration fails after its repair attempt', async () => {
    const llm = fakeLlmPort([{ error: 'model adapter error' }, { error: 'model adapter error' }])
    const { result } = await run({ adapters: twoSources(), llm: llm.port }, { question: 'q', queries: ['q'] })
    expect(result.status).toBe('degraded')
    expect(result.degradedReason).toContain('integration failed')
  })

  it('runs one follow-up round when the integrator flags a gap', async () => {
    const seenQueries: string[] = []
    const adapters = [
      createFakeAdapter('tavily', (query) => {
        seenQueries.push(query)
        return [hit('tavily', 'https://a.example/1', 's', query)]
      }),
    ]
    const llm = fakeLlmPort([
      integrationJson({ followup: { needed: true, queries: ['gap query'] } }),
      integrationJson({ summary: 'After followup.' }),
    ])
    const { result } = await run({ adapters, llm: llm.port }, { question: 'q', queries: ['seed'] })
    expect(result.status).toBe('ok')
    expect(result.summary).toBe('After followup.')
    expect(result.coverage.rounds).toBe(2)
    expect(seenQueries).toContain('gap query')
    expect(result.coverage.queries).toEqual(['seed', 'gap query'])
    expect(llm.calls[1]?.user).toContain('FINAL round')
  })

  it('keeps the first-pass result when the follow-up integration fails', async () => {
    const llm = fakeLlmPort([
      integrationJson({ followup: { needed: true, queries: ['gap'] } }),
      { error: 'adapter error' },
      { error: 'adapter error' },
    ])
    const { result } = await run({ adapters: twoSources(), llm: llm.port }, { question: 'q', queries: ['q'] })
    expect(result.status).toBe('ok')
    expect(result.summary).toBe('Integrated answer.')
    expect(result.unknowns.some((text) => text.includes('follow-up round failed'))).toBe(true)
  })

  it('skips the follow-up round when disabled by settings', async () => {
    const llm = fakeLlmPort([integrationJson({ followup: { needed: true, queries: ['gap'] } })])
    const adapters = [createFakeAdapter('tavily', () => [hit('tavily', 'https://a.example/1', 's')])]
    const { result } = await run({
      adapters, llm: llm.port,
      settings: baseSettings({ followupRounds: 0 }),
    }, { question: 'q' })
    expect(result.coverage.rounds).toBe(1)
  })

  it('does not call the planner when the caller supplied queries', async () => {
    const llm = fakeLlmPort([integrationJson()])
    await run({ adapters: twoSources(), llm: llm.port }, { question: 'the question', queries: ['seed query'] })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.user).toContain('Evidence (')
  })

  it('plans queries from the question when none were supplied', async () => {
    const llm = fakeLlmPort([
      '{"queries": ["planned one", "planned two"]}',
      integrationJson(),
    ])
    const seen: string[] = []
    const adapters = [createFakeAdapter('tavily', (query) => {
      seen.push(query)
      return [hit('tavily', 'https://a.example/1', 's', query)]
    })]
    await run({ adapters, llm: llm.port }, { question: 'the question' })
    expect(seen.sort()).toEqual(['planned one', 'planned two'])
  })

  it('propagates cancellation from the caller signal', async () => {
    const controller = new AbortController()
    const adapters = [createFakeAdapter('tavily', (_query, signal) => new Promise<RawHit[]>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))]
    setTimeout(() => controller.abort(), 10)
    await expect(run(
      { adapters, llm: fakeLlmPort([integrationJson()]).port },
      { question: 'q' },
      controller.signal,
    )).rejects.toThrow('aborted')
  })

  it('enforces the shared wall-clock budget', async () => {
    const adapters = [createFakeAdapter('tavily', (_query, signal) => new Promise<RawHit[]>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('budget aborted')))
    }))]
    await expect(run(
      {
        adapters,
        llm: fakeLlmPort([integrationJson()]).port,
        settings: baseSettings({ totalBudgetMs: 20 }),
      },
      { question: 'q', queries: ['q'] },
    )).rejects.toThrow(/abort/i)
  })

  it('honors the render budget for large results', async () => {
    const big = integrationJson({
      summary: 'x'.repeat(2000),
      points: Array.from({ length: 20 }, (_, i) => ({
        text: `point ${i} ${'y'.repeat(200)}`, status: 'supported', sources: [1],
      })),
      unknowns: Array.from({ length: 8 }, (_, i) => `unknown ${i} ${'z'.repeat(100)}`),
    })
    const { result } = await run({
      adapters: twoSources(),
      llm: fakeLlmPort([big]).port,
    }, { question: 'q', queries: ['q'] })
    const text = renderResearch(result, 3000)
    expect(text.length).toBeLessThanOrEqual(3400) // budget + small tolerance for the tail lines
    expect(text).toContain('Sources:')
  })
})

describe('v3 retrieval context and URL-only sources', () => {
  const integration = JSON.stringify({
    summary: 'ok', points: [{ text: 't', status: 'supported', sources: [1] }],
    unknowns: [], followup: { needed: false, queries: [] },
  })

  it('feeds the integrator a retrieval-context header (time, queries, failures)', async () => {
    const llm = fakeLlmPort([integration])
    await run({
      adapters: [createFakeAdapter('exa', () => [hit('exa', 'https://a.example/1', 's')])],
      llm: llm.port,
    }, { question: 'q', queries: ['q1'] })
    const user = llm.calls[0]?.user
    expect(user).toContain('Retrieval context:')
    expect(user).toContain('searched at:')
    expect(user).toContain('NOT a content-freshness guarantee')
    expect(user).toContain('q1')
    expect(user).toContain('failed entries: none')
    expect(user).toContain('URL-only')
  })

  it('reports a failed source in the retrieval context header', async () => {
    const llm = fakeLlmPort([integration])
    await run({
      adapters: [
        createFakeAdapter('exa', () => [hit('exa', 'https://a.example/1', 's')]),
        createFakeAdapter('tavily', () => {
          throw new Error('HTTP 429: limited')
        }),
      ],
      llm: llm.port,
    }, { question: 'q', queries: ['q'] })
    expect(llm.calls[0]?.user).toMatch(/tavily \(.*429/)
  })

  it('marks undated sources and keeps URL-only entries resolvable in the digest', async () => {
    const llm = fakeLlmPort([integration])
    await run({
      adapters: [createFakeAdapter('zhipu', () => [hit('zhipu', 'https://b.example/2', 'no date here')])],
      llm: llm.port,
      settings: baseSettings({ maxEvidence: 1, excerptChars: 4, fetchTopN: 0 }),
    }, { question: 'q', queries: ['q'] })
    const user = llm.calls[0]?.user
    expect(user).toContain('date unknown')
    expect(user).toContain('https://b.example/2')
  })
})
