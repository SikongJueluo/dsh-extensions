/**
 * The ChatGPT catalog filter: one filtered output feeds `listModels`, model discovery and
 * the status stats, and ids outside it are rejected before any network request.
 * @module dsh-more-providers/test/chatgpt-filter
 */
import type { Logger } from '@deepseek-ai/cordis'
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { FetchLike } from '../src/oauth/transport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileModelFilter } from '../src/catalog/filter.js'
import type { ModelFilter } from '../src/catalog/filter.js'
import { ModelCatalog } from '../src/providers/chatgpt/catalog.js'
import { chatGptStatus } from '../src/providers/chatgpt/index.js'
import {
  CHATGPT_BASE_URL,
  cleanupYamlFiles,
  collectStream,
  createHarness,
  disposeTracked,
  generateOptions,
  registeredAdapter,
  waitFor,
  type Harness,
} from './helpers.js'

const transport = vi.hoisted(() => ({ calls: [] as string[], models: [] as string[] }))

vi.mock(import('../src/oauth/transport.js'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createFetch: async (): Promise<FetchLike> => async (url) => {
      transport.calls.push(url)
      return url.includes('/models') ? payload(transport.models) : new Response('{}')
    },
  }
})

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const BASE_OPTIONS = { baseURL: 'https://backend.invalid', clientVersion: '9.9.9-test' }

function payload(slugs: readonly string[]): Response {
  return new Response(JSON.stringify({ models: slugs.map((slug) => ({ slug })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function unitCatalog(
  slugs: readonly string[],
  filter?: ModelFilter,
): { catalog: ModelCatalog; urls: string[] } {
  const urls: string[] = []
  const fetch: FetchLike = async (url) => {
    urls.push(url)
    return payload(slugs)
  }
  const catalog = new ModelCatalog({
    fetch,
    options: BASE_OPTIONS,
    ...(filter === undefined ? {} : { filter }),
  })
  return { catalog, urls }
}

function entryIds(entries: readonly { id: string }[]): string[] {
  return entries.map((entry) => entry.id)
}

/** The failure code a synchronous lookup throws, or undefined when it returns. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof LlmError ? error.code : String(error)
  }
}

describe('ModelCatalog filter output', () => {
  it('has no stats before the first load', () => {
    const { catalog } = unitCatalog(['gpt-5'])

    expect(catalog.current()).toEqual([])
    expect(catalog.stats()).toBeUndefined()
    expect(catalog.error()).toBeUndefined()
    expect(chatGptStatus(catalog)()).toEqual({ registered: true })
  })

  it('filters the output and counts the dropped ids', async () => {
    const { catalog, urls } = unitCatalog(
      ['gpt-5', 'gpt-5-mini', 'claude-5'],
      compileModelFilter({ exclude: [{ match: '-mini$' }] }),
    )

    expect(entryIds(await catalog.refresh())).toEqual(['gpt-5', 'claude-5'])
    expect(catalog.stats()).toEqual({
      discovered: 3,
      effective: 2,
      excluded: ['gpt-5-mini'],
      notIncluded: [],
    })
    expect(urls).toHaveLength(1)
  })

  it('serves the cached filtered view on the next refresh', async () => {
    const { catalog, urls } = unitCatalog(
      ['gpt-5', 'gpt-5-mini'],
      compileModelFilter({ exclude: [{ match: '-mini$' }] }),
    )

    await catalog.refresh()
    expect(entryIds(await catalog.refresh())).toEqual(['gpt-5'])
    expect(urls).toHaveLength(1)
  })

  it('lets exclude win over include', async () => {
    const { catalog } = unitCatalog(
      ['gpt-5', 'gpt-5-mini', 'claude-5'],
      compileModelFilter({
        include: [{ match: '^gpt-5' }],
        exclude: [{ match: '-mini$' }],
      }),
    )

    expect(entryIds(await catalog.refresh())).toEqual(['gpt-5'])
    expect(catalog.stats()).toEqual({
      discovered: 3,
      effective: 1,
      excluded: ['gpt-5-mini'],
      notIncluded: ['claude-5'],
    })
  })

  it('admits every model with an empty include group', async () => {
    const { catalog } = unitCatalog(['gpt-5', 'gpt-5-mini'], compileModelFilter({ include: [] }))

    expect(entryIds(await catalog.refresh())).toEqual(['gpt-5', 'gpt-5-mini'])
    expect(catalog.stats()).toEqual({
      discovered: 2,
      effective: 2,
      excluded: [],
      notIncluded: [],
    })
  })

  it('keeps an empty effective catalog from failing the load', async () => {
    const { catalog } = unitCatalog(['gpt-5'], compileModelFilter({ exclude: [{ match: '.' }] }))

    expect(await catalog.refresh()).toEqual([])
    expect(catalog.stats()).toEqual({
      discovered: 1,
      effective: 0,
      excluded: ['gpt-5'],
      notIncluded: [],
    })
    expect(catalog.error()).toBeUndefined()
  })

  it('reports a failed load and keeps the last good view', async () => {
    let fail = false
    const fetch: FetchLike = async () =>
      fail ? new Response('down', { status: 503 }) : payload(['gpt-5'])
    const catalog = new ModelCatalog({ fetch, options: BASE_OPTIONS })

    await catalog.refresh()
    fail = true
    await expect(catalog.forceRefresh()).rejects.toThrow(/HTTP 503/u)

    expect(catalog.error()).toContain('HTTP 503')
    expect(entryIds(catalog.current())).toEqual(['gpt-5'])
    const status = chatGptStatus(catalog)()
    expect(status.registered).toBe(true)
    expect(status.models).toEqual({
      discovered: 1,
      effective: 1,
      excluded: [],
      notIncluded: [],
    })
    expect(status.catalogError).toContain('HTTP 503')
  })
})

/** A logger that records every `warn` call for the filtered-empty assertions. */
function collectingLogger(): { logger: Logger; warns: unknown[][] } {
  const warns: unknown[][] = []
  const logger = {
    name: 'chatgpt-test',
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => {
      warns.push(args)
    },
    error: () => undefined,
  } as unknown as Logger
  return { logger, warns }
}

describe('ModelCatalog filtered-empty warning', () => {
  it('warns once per successful load when the filter removes every model', async () => {
    const { logger, warns } = collectingLogger()
    const catalog = new ModelCatalog({
      fetch: async () => payload(['gpt-5', 'gpt-6']),
      options: BASE_OPTIONS,
      logger,
      filter: compileModelFilter({
        include: [{ match: '^gpt-5$' }],
        exclude: [{ match: '^gpt-5$' }],
      }),
    })

    expect(await catalog.refresh()).toEqual([])
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.[0])).toContain('filter removed all %d models')
    expect(String(warns[0]?.[0])).toContain('the route stays mounted with no selectable models')
    expect(warns[0]?.slice(1)).toEqual([2, 1, 1])
  })

  it('warns again on the next successful load after the cache expires', async () => {
    const { logger, warns } = collectingLogger()
    const catalog = new ModelCatalog({
      fetch: async () => payload(['gpt-5']),
      options: BASE_OPTIONS,
      logger,
      ttlMs: 0,
      filter: compileModelFilter({ exclude: [{ match: '.' }] }),
    })

    await catalog.refresh()
    await catalog.refresh()

    expect(warns).toHaveLength(2)
  })

  it('stays quiet when the filter keeps at least one model', async () => {
    const { logger, warns } = collectingLogger()
    const catalog = new ModelCatalog({
      fetch: async () => payload(['gpt-5', 'gpt-5-mini']),
      options: BASE_OPTIONS,
      logger,
      filter: compileModelFilter({ exclude: [{ match: '-mini$' }] }),
    })

    expect(entryIds(await catalog.refresh())).toEqual(['gpt-5'])
    expect(warns).toEqual([])
  })

  it('stays quiet for a genuinely empty catalog', async () => {
    const { logger, warns } = collectingLogger()
    const catalog = new ModelCatalog({
      fetch: async () => payload([]),
      options: BASE_OPTIONS,
      logger,
      filter: compileModelFilter({ exclude: [{ match: '.' }] }),
    })

    await expect(catalog.refresh()).rejects.toThrow(/no usable models/u)
    expect(warns).toEqual([])
  })
})

describe('ModelCatalog model lookup', () => {
  it('rejects ids the loaded catalog does not serve', async () => {
    const { catalog } = unitCatalog(
      ['gpt-5', 'gpt-5-mini'],
      compileModelFilter({ exclude: [{ match: '-mini$' }] }),
    )
    await catalog.refresh()

    expect(catalog.resolve('gpt-5').id).toBe('gpt-5')
    expect(codeOf(() => catalog.resolve('gpt-5-mini'))).toBe('UNKNOWN_MODEL')
    expect(codeOf(() => catalog.resolve('never-listed'))).toBe('UNKNOWN_MODEL')
  })

  it('rejects a model the upstream dropped after a newer load', async () => {
    let slugs = ['gpt-5', 'claude-5']
    const fetch: FetchLike = async () => payload(slugs)
    const catalog = new ModelCatalog({ fetch, options: BASE_OPTIONS })

    await catalog.refresh()
    expect(catalog.resolve('claude-5').id).toBe('claude-5')

    slugs = ['gpt-5']
    await catalog.forceRefresh()
    expect(codeOf(() => catalog.resolve('claude-5'))).toBe('UNKNOWN_MODEL')
  })

  it('keeps the synthesized fallback until the first load', () => {
    const { catalog } = unitCatalog(['gpt-5'])

    expect(catalog.resolve('gpt-5-mini')).toEqual({
      id: 'gpt-5-mini',
      name: 'gpt-5-mini',
      reasoning: [],
      inputModalities: ['text', 'image'],
    })
  })
})

const FILTERED_YAML = [
  'providers:',
  '  chatgpt:',
  '    kind: chatgpt',
  `    baseURL: ${CHATGPT_BASE_URL}`,
  '    clientVersion: 9.9.9-test',
  '    filter:',
  '      exclude:',
  "        - match: '-mini$'",
].join('\n')

const UNFILTERED_YAML = [
  'providers:',
  '  chatgpt:',
  '    kind: chatgpt',
  `    baseURL: ${CHATGPT_BASE_URL}`,
  '    clientVersion: 9.9.9-test',
].join('\n')

/** Minimal structural view of the registered adapter's model listing and lookup. */
interface RouteAdapter {
  listModels(provider: string): Promise<readonly { id: string }[]>
  resolveModel(provider: string, model: string): Promise<{ id: string }>
}

function routeAdapter(harness: Harness): RouteAdapter {
  const entry = harness.llm.adapters.find((candidate) => candidate.providers.includes('chatgpt'))
  if (entry === undefined) throw new Error('the ChatGPT adapter was not registered')
  return entry.adapter as RouteAdapter
}

async function mountChatGpt(yaml: string, slugs: readonly string[]): Promise<Harness> {
  transport.models = [...slugs]
  transport.calls.length = 0
  const harness = await createHarness({ yaml })
  await waitFor(
    () => harness.llm.adapters.some((entry) => entry.providers.includes('chatgpt')),
    'the ChatGPT adapter to mount',
  )
  transport.calls.length = 0
  return harness
}

function streamChatGpt(
  harness: Harness,
  model: string,
): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  return collectStream(
    registeredAdapter(harness.llm, 'chatgpt').stream(generateOptions('chatgpt', model, messages)),
  )
}

function discoveryOf(harness: Harness): () => Promise<readonly { id: string }[]> {
  return harness.llm.discoveries.get('more-providers') as () => Promise<readonly { id: string }[]>
}

describe('ChatGPT route filter', () => {
  it('serves the filtered catalog through listModels', async () => {
    const harness = await mountChatGpt(FILTERED_YAML, ['gpt-5', 'gpt-5-mini'])

    expect(entryIds(await routeAdapter(harness).listModels('chatgpt'))).toEqual(['gpt-5'])
  })

  it('serves the same filtered catalog through model discovery', async () => {
    const harness = await mountChatGpt(FILTERED_YAML, ['gpt-5', 'gpt-5-mini', 'claude-5'])

    expect(entryIds(await discoveryOf(harness)())).toEqual(['gpt-5', 'claude-5'])
    expect(entryIds(await routeAdapter(harness).listModels('chatgpt'))).toEqual([
      'gpt-5',
      'claude-5',
    ])
  })

  it('rejects a filtered model in resolveModel', async () => {
    const harness = await mountChatGpt(FILTERED_YAML, ['gpt-5', 'gpt-5-mini'])
    const adapter = routeAdapter(harness)
    await adapter.listModels('chatgpt')

    await expect(adapter.resolveModel('chatgpt', 'gpt-5-mini')).rejects.toMatchObject({
      code: 'UNKNOWN_MODEL',
    })
    await expect(adapter.resolveModel('chatgpt', 'gpt-5')).resolves.toMatchObject({ id: 'gpt-5' })
  })

  it('rejects a filtered model before any network request', async () => {
    const harness = await mountChatGpt(FILTERED_YAML, ['gpt-5', 'gpt-5-mini'])
    await routeAdapter(harness).listModels('chatgpt')
    transport.calls.length = 0

    const { chunks, error } = await streamChatGpt(harness, 'gpt-5-mini')

    expect(chunks).toEqual([])
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNKNOWN_MODEL')
    expect(transport.calls).toEqual([])
  })

  it('rejects a model the upstream dropped after a newer load', async () => {
    const harness = await mountChatGpt(UNFILTERED_YAML, ['gpt-5', 'claude-5'])
    const adapter = routeAdapter(harness)
    await adapter.listModels('chatgpt')

    transport.models = ['gpt-5']
    await discoveryOf(harness)()

    await expect(adapter.resolveModel('chatgpt', 'claude-5')).rejects.toMatchObject({
      code: 'UNKNOWN_MODEL',
    })
  })

  it('streams before the first catalog load, the documented exception', async () => {
    const harness = await mountChatGpt(FILTERED_YAML, ['gpt-5', 'gpt-5-mini'])
    expect(transport.calls).toEqual([])

    await streamChatGpt(harness, 'gpt-9-unknown')

    expect(transport.calls).toHaveLength(1)
  })
})
