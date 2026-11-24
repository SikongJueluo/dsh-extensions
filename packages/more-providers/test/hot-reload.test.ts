/**
 * Hot-reload contract: a valid edit rebuilds and atomically replaces the registration,
 * a broken edit keeps the previous one live, pool health survives a rebuild, and a
 * burst of edits applies once.
 * @module dsh-more-providers/test/hot-reload
 */
import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupYamlFiles,
  collectStream,
  createHarness,
  disposeTracked,
  generateOptions,
  registeredAdapter,
  waitFor,
  TEST_ENV_KEY,
} from './helpers.js'
import type { Harness } from './helpers.js'

interface SnapshotInstance {
  state: 'ok' | 'invalid' | 'missing'
  revision: number
  appliedRevision?: number
  providers: { route: string; registered: boolean; models?: { effective: number } }[]
}

interface Snapshot {
  instances: SnapshotInstance[]
}

function documentOf(models: readonly string[]): string {
  return [
    'providers:',
    '  mdkj:',
    '    kind: custom',
    '    api: openai-responses',
    '    baseURL: https://reload.invalid/v1',
    `    apiKeyEnv: ${TEST_ENV_KEY}`,
    '    models:',
    ...models.map((id) => `      - id: ${id}`),
    '  chatgpt: { kind: chatgpt, enabled: false }',
  ].join('\n')
}

function pooledDocument(accounts: Record<string, string>): string {
  return [
    'providers:',
    '  mdkj:',
    '    kind: custom',
    '    api: openai-responses',
    '    baseURL: https://reload.invalid/v1',
    '    models:',
    '      - id: m',
    '    accounts:',
    ...Object.entries(accounts).map(([id, env]) => `      ${id}: { apiKeyEnv: ${env} }`),
    '  chatgpt: { kind: chatgpt, enabled: false }',
  ].join('\n')
}

/** A route whose served models are decided by one exclude pattern. */
function filteredDocument(exclude: string): string {
  return [
    'providers:',
    '  mdkj:',
    '    kind: custom',
    '    api: openai-responses',
    '    baseURL: https://reload.invalid/v1',
    `    apiKeyEnv: ${TEST_ENV_KEY}`,
    '    models:',
    '      - id: alpha',
    '      - id: beta',
    '    filter:',
    '      exclude:',
    `        - { match: '${exclude}' }`,
    '  chatgpt: { kind: chatgpt, enabled: false }',
  ].join('\n')
}

/** A fetched catalog plus one global defaults rule, so an edit can move metadata only. */
function defaultsDocument(match: string, input: string): string {
  return [
    'defaults:',
    '  modelDefaults:',
    `    - { match: '${match}', input: [${input}] }`,
    'providers:',
    '  mdkj:',
    '    kind: custom',
    '    api: openai-responses',
    '    baseURL: https://reload.invalid/v1',
    `    apiKeyEnv: ${TEST_ENV_KEY}`,
    '    modelsURL: https://reload.invalid/v1/models',
    '  chatgpt: { kind: chatgpt, enabled: false }',
  ].join('\n')
}

async function settleWatch(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50)
  })
}

async function readSnapshot(harness: Harness): Promise<SnapshotInstance | undefined> {
  await waitFor(
    () => harness.web.routes.some((route) => route.def.path === '/dsh-more-providers/providers'),
    'the providers status route',
  )
  const route = harness.web.routes.find(
    (candidate) => candidate.def.path === '/dsh-more-providers/providers',
  )
  if (route === undefined || !('resource' in route.def)) {
    throw new Error('the providers status route was not registered')
  }
  const payload = (await (await route.def.resource()).json()) as Snapshot
  return payload.instances.find((instance) => instance.file === harness.file)
}

/** The model-listing face of a registered adapter. */
interface ModelListing {
  listModels(provider: string): Promise<readonly { id: string; inputModalities?: string[] }[]>
}

async function listIds(adapter: unknown): Promise<string[]> {
  const listing = adapter as ModelListing
  return (await listing.listModels('mdkj')).map((model) => model.id)
}

async function modelIds(harness: Harness): Promise<string[]> {
  return listIds(registeredAdapter(harness.llm, 'mdkj'))
}

/** The modalities the served catalog advertises for one id; absent when the route no longer serves it. */
async function inputModalities(
  harness: Harness,
  id: string,
): Promise<readonly string[] | undefined> {
  const listing = registeredAdapter(harness.llm, 'mdkj') as ModelListing
  const models = await listing.listModels('mdkj')
  return models.find((model) => model.id === id)?.inputModalities
}

/** Poll an async condition, since reading the status route is async. */
async function waitUntil(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error(`timed out waiting for ${what}`)
}

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('hot reload: a valid edit rebuilds the registration', () => {
  it('replaces the route set, re-serves the new catalog and emits adapters-updated', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: documentOf(['gpt-6']) })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    const firstAdapter = registeredAdapter(harness.llm, 'mdkj')
    expect(await modelIds(harness)).toEqual(['gpt-6'])
    await settleWatch()

    const updates: number[] = []
    harness.ctx.on('llm/adapters-updated', () => {
      updates.push(1)
    })
    await writeFile(harness.file, documentOf(['gpt-6', 'gpt-8']))

    await waitFor(() => harness.llm.registrations.length === 2, 'the adapter replacement')
    expect(harness.llm.registrations[1]).toEqual(['mdkj'])
    expect(updates.length).toBeGreaterThan(0)
    const secondAdapter = registeredAdapter(harness.llm, 'mdkj')
    expect(secondAdapter).not.toBe(firstAdapter)
    expect(await modelIds(harness)).toEqual(['gpt-6', 'gpt-8'])
    expect(await listIds(firstAdapter)).toEqual(['gpt-6'])
    expect(harness.llm.adapters.filter((entry) => entry.providers.includes('mdkj'))).toHaveLength(1)

    const instance = await readSnapshot(harness)
    expect(instance?.state).toBe('ok')
    expect(instance?.appliedRevision).toBe(instance?.revision)
    expect(instance?.providers[0]?.models?.effective).toBe(2)
  })
})

describe('hot reload: an edit that only moves a pattern still re-registers', () => {
  it('re-serves the filtered model set when only an exclude pattern changes', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: filteredDocument('^beta$') })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    expect(await modelIds(harness)).toEqual(['alpha'])
    await settleWatch()

    await writeFile(harness.file, filteredDocument('^alpha$'))

    await waitFor(() => harness.llm.registrations.length === 2, 'the pattern-only reload')
    expect(await modelIds(harness)).toEqual(['beta'])
  })

  it('re-serves model metadata when only a defaults pattern changes', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'm-one' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const harness = await createHarness({ yaml: defaultsDocument('^m', 'text') })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    expect(await inputModalities(harness, 'm-one')).toEqual(['text'])
    await settleWatch()

    await writeFile(harness.file, defaultsDocument('^m', 'text, image'))

    await waitFor(() => harness.llm.registrations.length === 2, 'the metadata-only reload')
    expect(await inputModalities(harness, 'm-one')).toEqual(['text', 'image'])
  })
})

describe('hot reload: a broken edit keeps the previous registration', () => {
  it('serves the last good catalog while reporting the document invalid', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: documentOf(['gpt-6']) })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    await settleWatch()

    await writeFile(harness.file, 'providers:\n  mdkj:\n    kind: nope\n')
    await waitUntil(
      async () => (await readSnapshot(harness))?.state === 'invalid',
      'the invalid state',
    )

    const instance = await readSnapshot(harness)
    expect(instance?.revision).toBeGreaterThan(1)
    expect(instance?.appliedRevision).toBe(1)
    expect(instance?.providers.map((provider) => [provider.route, provider.registered])).toEqual([
      ['mdkj', true],
      ['chatgpt', false],
    ])
    expect(harness.llm.registrations).toHaveLength(1)
    expect(await modelIds(harness)).toEqual(['gpt-6'])
  })
})

describe('hot reload: a refused route set rolls back', () => {
  it('keeps the previous routes when another adapter owns the new route', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: documentOf(['gpt-6']) })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    const firstAdapter = registeredAdapter(harness.llm, 'mdkj')
    await settleWatch()

    const releaseConflict = harness.llm.service.registerAdapter(['conflict'], {})
    await writeFile(
      harness.file,
      documentOf(['gpt-6', 'gpt-9']).replace(
        '  mdkj:\n    kind: custom',
        '  mdkj:\n    kind: custom\n    routeId: conflict',
      ),
    )

    await waitUntil(async () => (await readSnapshot(harness))?.state === 'invalid', 'invalid state')
    const instance = await readSnapshot(harness)
    expect(instance?.error).toContain('the previous registration was restored')
    expect(instance?.appliedRevision).toBe(1)
    expect(harness.llm.adapters.some((entry) => entry.providers.includes('mdkj'))).toBe(true)
    expect(harness.llm.adapters.some((entry) => entry.providers.includes('conflict'))).toBe(true)
    expect(registeredAdapter(harness.llm, 'mdkj')).toBe(firstAdapter)
    expect(await modelIds(harness)).toEqual(['gpt-6'])

    releaseConflict()
    await writeFile(harness.file, documentOf(['gpt-6', 'gpt-9']))
    await waitUntil(async () => (await readSnapshot(harness))?.state === 'ok', 'recovered state')
    const recovered = await readSnapshot(harness)
    expect(recovered?.appliedRevision).toBe(recovered?.revision)
    expect(await modelIds(harness)).toEqual(['gpt-6', 'gpt-9'])
    expect(harness.llm.adapters.filter((entry) => entry.providers.includes('mdkj'))).toHaveLength(1)
  })
})

describe('hot reload: a failed rollback is reported, not hidden', () => {
  it('names the unrestored registration in the status error', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: documentOf(['gpt-6']) })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    await settleWatch()

    harness.llm.refuseNext(2)
    await writeFile(harness.file, documentOf(['gpt-6', 'gpt-9']))

    await waitUntil(
      async () => (await readSnapshot(harness))?.state === 'invalid',
      'the invalid state',
    )
    const instance = await readSnapshot(harness)
    expect(instance?.error).toContain('the previous registration could not be restored')
    expect(instance?.appliedRevision).toBe(1)
    expect(harness.llm.adapters.some((entry) => entry.providers.includes('mdkj'))).toBe(false)
  })
})

describe('hot reload: pool health survives a rebuild', () => {
  it('keeps a cooling account cooling across a valid reload', async () => {
    vi.stubEnv('MORE_PROVIDERS_RELOAD_A', 'key-a')
    vi.stubEnv('MORE_PROVIDERS_RELOAD_B', 'key-b')
    const authorizations: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      authorizations.push(authorization)
      if (authorization.endsWith('key-a')) {
        return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })
      }
      return new Response(
        [
          'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}',
          '',
          'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const harness = await createHarness({
      yaml: pooledDocument({
        stable: 'MORE_PROVIDERS_RELOAD_A',
        cheap: 'MORE_PROVIDERS_RELOAD_B',
      }),
    })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    const keys = harness.ctx.get('providerKeys') as {
      accounts(route: string): readonly { id: string; healthy?: boolean }[]
    }

    await collectStream(
      registeredAdapter(harness.llm, 'mdkj').stream(
        generateOptions('mdkj', 'm', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
      ),
    )
    expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
    expect(keys.accounts('mdkj')[0]).toMatchObject({ id: 'stable', healthy: false })
    await settleWatch()

    const reloaded = pooledDocument({
      stable: 'MORE_PROVIDERS_RELOAD_A',
      cheap: 'MORE_PROVIDERS_RELOAD_B',
    }).replace('models:\n      - id: m', 'models:\n      - id: m\n      - id: m2')
    await writeFile(harness.file, reloaded)
    await waitFor(() => harness.llm.registrations.length === 2, 'the adapter replacement')

    expect(keys.accounts('mdkj')).toStrictEqual([
      expect.objectContaining({ id: 'stable', healthy: false }),
      expect.objectContaining({ id: 'cheap', healthy: true }),
    ])
  })

  it('applies a burst of edits once and lands on the last content', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: documentOf(['gpt-6']) })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    await settleWatch()

    await writeFile(harness.file, documentOf(['gpt-6', 'gpt-7']))
    await writeFile(harness.file, documentOf(['gpt-6', 'gpt-8']))
    await waitFor(() => harness.llm.registrations.length === 2, 'the single replacement')
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 120)
    })

    expect(harness.llm.registrations).toEqual([['mdkj'], ['mdkj']])
    expect(await modelIds(harness)).toEqual(['gpt-6', 'gpt-8'])
  })
})

describe('hot reload: failure classification of rebuild paths', () => {
  it('reports invalid when the rebuilt catalog cannot produce a route', async () => {
    vi.stubEnv(TEST_ENV_KEY, 'reload-key')
    const harness = await createHarness({ yaml: documentOf(['gpt-6']) })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('mdkj')),
      'the initial registration',
    )
    await settleWatch()

    await writeFile(
      harness.file,
      documentOf(['gpt-6']).replace(
        '  mdkj:\n    kind: custom',
        '  mdkj:\n    kind: builtin\n    catalog: not-a-catalog',
      ),
    )
    await waitUntil(
      async () => (await readSnapshot(harness))?.state === 'invalid',
      'the invalid state',
    )

    expect(harness.llm.registrations).toHaveLength(1)
    expect(await modelIds(harness)).toEqual(['gpt-6'])
  })
})
