/**
 * Catalog re-fetch contract: POST `/dsh-more-providers/refresh` re-runs discovery without a config
 * edit, replaces the served catalog when a provider recovers, and reports the routes still failing.
 * @module dsh-more-providers/test/refresh
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_ENV_KEY,
  cleanupYamlFiles,
  createHarness,
  disposeTracked,
  registeredAdapter,
  waitFor,
  type Harness,
} from './helpers.js'

const REFRESH_PATH = '/dsh-more-providers/refresh'
const STATUS_PATH = '/dsh-more-providers/providers'

interface SnapshotProvider {
  route: string
  registered: boolean
  models?: { discovered: number; effective: number }
  catalogError?: string
  error?: string
}

interface SnapshotInstance {
  revision: number
  appliedRevision?: number
  providers: SnapshotProvider[]
}

interface RefreshReport {
  id: string
  ok: boolean
  error?: string
}

/** One catalog document: discovery only, so a failed fetch leaves the route without models. */
function discoveredDocument(): string {
  return [
    'providers:',
    '  mdkj:',
    '    kind: custom',
    '    api: openai-responses',
    '    baseURL: https://refresh.invalid/v1',
    `    apiKeyEnv: ${TEST_ENV_KEY}`,
    '    modelsURL: https://refresh.invalid/v1/models',
    '  chatgpt: { kind: chatgpt, enabled: false }',
  ].join('\n')
}

/** The same route plus a static fallback, so a failed discovery stays registered. */
function fallbackDocument(): string {
  return [
    'providers:',
    '  mdkj:',
    '    kind: custom',
    '    api: openai-responses',
    '    baseURL: https://refresh.invalid/v1',
    `    apiKeyEnv: ${TEST_ENV_KEY}`,
    '    modelsURL: https://refresh.invalid/v1/models',
    '    models:',
    '      - id: static-only',
    '  chatgpt: { kind: chatgpt, enabled: false }',
  ].join('\n')
}

/** A `modelsURL` double whose reachability the test flips between calls. */
function stubCatalog(reachable: { up: boolean }): void {
  vi.stubGlobal('fetch', async () => {
    if (!reachable.up) return new Response('down', { status: 503 })
    return new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

/** The model ids the registered adapter serves. */
async function servedIds(harness: Harness): Promise<string[]> {
  const adapter = registeredAdapter(harness.llm, 'mdkj') as {
    listModels(provider: string): Promise<readonly { id: string }[]>
  }
  return (await adapter.listModels('mdkj')).map((model) => model.id)
}

async function readSnapshot(harness: Harness): Promise<SnapshotInstance | undefined> {
  await waitFor(
    () => harness.web.routes.some((route) => route.def.path === STATUS_PATH),
    'the providers status route',
  )
  const route = harness.web.routes.find((candidate) => candidate.def.path === STATUS_PATH)
  if (route === undefined || !('resource' in route.def)) {
    throw new Error('the providers status route was not registered')
  }
  const payload = (await (await route.def.resource()).json()) as { instances: SnapshotInstance[] }
  return payload.instances.find((instance) => instance.file === harness.file)
}

/** POST the refresh route the plugin registered and read its report. */
async function postRefresh(
  harness: Harness,
  method = 'POST',
): Promise<{ status: number; reports: RefreshReport[] }> {
  await waitFor(
    () => harness.web.routes.some((route) => route.def.path === REFRESH_PATH),
    'the refresh route',
  )
  const route = harness.web.routes.find((candidate) => candidate.def.path === REFRESH_PATH)
  if (route === undefined || !('handler' in route.def)) {
    throw new Error('the refresh route was not registered')
  }
  const req = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage
  req.method = method
  req.url = REFRESH_PATH
  req.headers = { 'content-type': 'application/json' }
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status: number): unknown {
      captured.status = status
      return res
    },
    end(body?: string): unknown {
      captured.body = body ?? ''
      return res
    },
  } as unknown as ServerResponse
  await route.def.handler(req, res)
  if (captured.status !== 200) return { status: captured.status, reports: [] }
  const payload = JSON.parse(captured.body) as { instances?: RefreshReport[] }
  return { status: captured.status, reports: payload.instances ?? [] }
}

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('catalog re-fetch: the settings page retries discovery', () => {
  it('registers a route whose startup discovery failed and refreshes the catalog in place', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'refresh-key')
    const reachable = { up: false }
    stubCatalog(reachable)
    const harness = await createHarness({ yaml: discoveredDocument() })
    const before = await readSnapshot(harness)
    expect(before?.providers[0]?.registered).toBe(false)
    expect(harness.llm.adapters).toEqual([])

    const updates: number[] = []
    harness.ctx.on('llm/adapters-updated', () => {
      updates.push(1)
    })
    reachable.up = true
    const result = await postRefresh(harness)

    expect(result.status).toBe(200)
    expect(result.reports).toEqual([{ id: 'more-providers#1', ok: true }])
    expect(updates.length).toBeGreaterThan(0)
    expect(await servedIds(harness)).toEqual(['alpha', 'beta'])
    const after = await readSnapshot(harness)
    expect(after?.providers[0]?.registered).toBe(true)
    expect(after?.providers[0]?.models).toEqual({
      discovered: 2,
      effective: 2,
      excluded: [],
      notIncluded: [],
    })
    expect(after?.revision).toBe(before?.revision)
    expect(after?.appliedRevision).toBe(before?.appliedRevision)
  })

  it('keeps the static fallback serving and reports the discovery failure', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'refresh-key')
    const reachable = { up: false }
    stubCatalog(reachable)
    const harness = await createHarness({ yaml: fallbackDocument() })
    const before = await readSnapshot(harness)
    expect(before?.providers[0]?.registered).toBe(true)
    expect(before?.providers[0]?.catalogError).toBe('model catalog returned 503')

    const result = await postRefresh(harness)

    expect(result.status).toBe(200)
    expect(result.reports).toEqual([
      { id: 'more-providers#1', ok: false, error: 'mdkj: model catalog returned 503' },
    ])
    expect(await servedIds(harness)).toEqual(['static-only'])
    expect(harness.llm.adapters).toHaveLength(1)
    const after = await readSnapshot(harness)
    expect(after?.revision).toBe(before?.revision)
    expect(after?.appliedRevision).toBe(before?.appliedRevision)
  })

  it('keeps a working route serving when the retry fails again', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'refresh-key')
    const reachable = { up: true }
    stubCatalog(reachable)
    const harness = await createHarness({ yaml: discoveredDocument() })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    expect(await servedIds(harness)).toEqual(['alpha', 'beta'])

    reachable.up = false
    const result = await postRefresh(harness)

    expect(result.status).toBe(200)
    expect(result.reports).toEqual([
      { id: 'more-providers#1', ok: false, error: 'mdkj: no account has a usable model catalog' },
    ])
    expect(await servedIds(harness)).toEqual(['alpha', 'beta'])
    expect(harness.llm.adapters).toHaveLength(1)
    const after = await readSnapshot(harness)
    expect(after?.providers[0]?.registered).toBe(true)
    expect(after?.providers[0]?.models?.effective).toBe(2)
  })

  it('answers only POST', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'refresh-key')
    stubCatalog({ up: true })
    const harness = await createHarness({ yaml: discoveredDocument() })
    const result = await postRefresh(harness, 'GET')
    expect(result.status).toBe(405)
    expect(result.reports).toEqual([])
  })
})
