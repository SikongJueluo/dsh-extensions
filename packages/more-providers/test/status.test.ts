/**
 * The `/dsh-more-providers/providers` snapshot: instance aggregation across mounted
 * configs, the payload shape the settings page reads, and the route handoff when an
 * instance unloads.
 * @module dsh-more-providers/test/status
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerConfig, type ConfigStore } from '@dsh-extensions/config'
import { resolveConfig } from '../src/config.js'
import { apply, inject, name } from '../src/index.js'
import {
  accountHealth,
  cooldownParts,
  parseSnapshot,
  routesById,
  servingRevision,
  type SnapshotAccount,
  type SnapshotProvider,
} from '../src/client/snapshot.js'
import {
  registerProvidersStatusRoute,
  type ProviderStatus,
  type ProvidersStatus,
} from '../src/status.js'
import {
  chatgptYaml,
  cleanupYamlFiles,
  createHarness,
  disposeTracked,
  gatewayYaml,
  TEST_ENV_KEY,
  waitFor,
} from './helpers.js'

const PREFIX = '/dsh-test-providers'
const PATH = `${PREFIX}/providers`
const PLUGIN_PATH = '/dsh-more-providers/providers'

interface StubRoute {
  kind: string
  path: string
  resource: () => Promise<Response>
}

class FakeWebServer extends Service {
  readonly routes = new Map<string, StubRoute>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: StubRoute): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    this.routes.set(route.path, route)
    return () => {
      this.routes.delete(route.path)
    }
  }
}

const directories: string[] = []

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-more-providers-status-'))
  directories.push(directory)
  return directory
}

async function cleanupDirectories(): Promise<void> {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeYaml(doc: string): Promise<string> {
  const file = join(await tempDirectory(), 'more-providers.yaml')
  await writeFile(file, doc)
  return file
}

async function statusOf(path: string, server: FakeWebServer): Promise<ProvidersStatus> {
  const route = server.routes.get(path)
  if (route === undefined) throw new Error(`the ${path} route was not registered`)
  return (await (await route.resource()).json()) as Promise<ProvidersStatus>
}

function routeStatus(id: string, overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    route: id,
    kind: 'custom',
    auth: 'api-key',
    displayName: id,
    enabled: true,
    registered: true,
    accounts: [{ id, displayName: id, ready: true }],
    models: { discovered: 2, effective: 1, excluded: [], notIncluded: ['hidden-model'] },
    ...overrides,
  }
}

function viewProvider(overrides: Partial<SnapshotProvider> = {}): SnapshotProvider {
  return {
    route: 'gateway',
    kind: 'custom',
    auth: 'api-key',
    displayName: 'Gateway',
    enabled: true,
    registered: true,
    accounts: [],
    models: {
      discovered: 4,
      effective: 2,
      excluded: ['excluded-model'],
      notIncluded: ['not-included-model'],
    },
    ...overrides,
  }
}

function poolAccount(overrides: Partial<SnapshotAccount> = {}): SnapshotAccount {
  return { id: 'stable', displayName: 'Stable', ready: true, healthy: true, ...overrides }
}

function mount(
  root: Context,
  server: FakeWebServer,
  options: {
    file?: string
    store?: ConfigStore<unknown>
    source: () => readonly ProviderStatus[]
    title?: string
  },
) {
  return root.plugin(async (ctx) => {
    let store: ConfigStore<unknown>
    if (options.store !== undefined) {
      store = options.store
    } else if (options.file === undefined) {
      store = stubStore('/missing/more-providers.yaml', {
        loaded: true,
        revision: 1,
        value: undefined,
        error: undefined,
      })
    } else {
      store = registerConfig(ctx, {
        filename: 'more-providers.yaml',
        configFile: options.file,
        validate: resolveConfig,
      }) as ConfigStore<unknown>
      await store.ready
    }
    registerProvidersStatusRoute(ctx, {
      prefix: PREFIX,
      title: options.title ?? 'more-providers',
      store,
      source: options.source,
    })
  })
}

/** A store with a fixed state, for the states a real file cannot reach cheaply. */
function stubStore(
  file: string,
  state: {
    loaded: boolean
    revision: number
    value: unknown
    error: string | undefined
  },
): ConfigStore<unknown> {
  const snapshot = { file, ...state }
  return {
    file,
    ready: Promise.resolve(snapshot),
    state: () => snapshot,
    get: () => snapshot.value,
    subscribe: () => () => {},
    reportFailure: () => {},
    dispose: async () => {},
  }
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return
    await new Promise<void>((settle) => {
      setTimeout(settle, 5)
    })
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('providers snapshot route', () => {
  afterEach(async () => {
    await cleanupDirectories()
  })

  it('aggregates instances over one shared route and hands it to the survivor', async () => {
    const firstFile = await writeYaml('providers: {}\n')
    const secondFile = await writeYaml('providers: {}\n')
    const root = new Context()
    const server = new FakeWebServer(root)

    const first = mount(root, server, { file: firstFile, source: () => [routeStatus('gateway')] })
    await first
    const second = mount(root, server, { file: secondFile, source: () => [routeStatus('other')] })
    await second
    await waitFor(() => server.routes.size === 1, 'one shared route')

    const both = await statusOf(PATH, server)
    expect(both.instances).toHaveLength(2)
    expect(both.instances.map((instance) => instance.file).toSorted()).toEqual(
      [firstFile, secondFile].toSorted(),
    )
    expect(both.instances.map((instance) => instance.id)).toEqual([
      'more-providers#1',
      'more-providers#2',
    ])
    expect(both.instances.every((instance) => instance.state === 'ok')).toBe(true)
    expect(both.instances[0]?.revision).toBeGreaterThan(0)
    expect(both.instances[0]?.error).toBeUndefined()

    const mine = both.instances.find((instance) => instance.file === secondFile)
    expect(mine?.providers).toEqual([routeStatus('other')])

    await first.dispose()
    await waitFor(() => server.routes.size === 1, 'the route handoff')
    const remaining = await statusOf(PATH, server)
    expect(remaining.instances).toHaveLength(1)
    expect(remaining.instances[0]?.file).toBe(secondFile)

    await second.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })

  it('reads the source on every request, so a rebuilt route set shows up', async () => {
    const file = await writeYaml('providers: {}\n')
    const root = new Context()
    const server = new FakeWebServer(root)
    let routes: ProviderStatus[] = [routeStatus('gateway')]

    const mounted = mount(root, server, { file, source: () => routes })
    await mounted
    const before = await statusOf(PATH, server)
    expect(before.instances[0]?.providers).toEqual([routeStatus('gateway')])

    routes = [
      routeStatus('gateway', { registered: false, models: undefined, error: 'no readable key' }),
    ]
    const after = await statusOf(PATH, server)
    expect(after.instances[0]?.providers).toEqual([
      routeStatus('gateway', { registered: false, models: undefined, error: 'no readable key' }),
    ])

    await mounted.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })

  it('reports an invalid document with its reason and the configured routes untouched', async () => {
    const file = await writeYaml('providers:\n  gateway:\n    bogusField: 1\n')
    const root = new Context()
    const server = new FakeWebServer(root)
    const mounted = mount(root, server, { file, source: () => [] })
    await mounted

    const status = await statusOf(PATH, server)
    expect(status.instances).toHaveLength(1)
    expect(status.instances[0]?.state).toBe('invalid')
    expect(status.instances[0]?.error).toContain('bogusField')
    expect(status.instances[0]?.providers).toEqual([])

    await mounted.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })

  it('keeps a validation error invalid even when its message mentions ENOENT', async () => {
    const file = await writeYaml(
      [
        'providers:',
        '  gateway:',
        '    kind: custom',
        '    api: openai-responses',
        '    baseURL: https://gateway.invalid/v1',
        '    apiKeyEnv: MORE_PROVIDERS_TEST_KEY',
        '    models:',
        '      - id: gateway-large',
        '    ENOENT: 1',
      ].join('\n'),
    )
    const root = new Context()
    const server = new FakeWebServer(root)
    const mounted = mount(root, server, { file, source: () => [] })
    await mounted

    const status = await statusOf(PATH, server)
    expect(status.instances[0]?.state).toBe('invalid')
    expect(status.instances[0]?.error).toContain('ENOENT')

    await mounted.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })

  it('maps an unreadable store reason to invalid', async () => {
    const root = new Context()
    const server = new FakeWebServer(root)
    const mounted = mount(root, server, {
      source: () => [],
      store: stubStore('/secret/more-providers.yaml', {
        loaded: true,
        revision: 1,
        value: undefined,
        error: 'cannot read the file: EACCES: permission denied',
        reason: 'unreadable',
      }),
    })
    await mounted

    const status = await statusOf(PATH, server)
    expect(status.instances[0]?.state).toBe('invalid')
    expect(status.instances[0]?.error).toContain('EACCES')

    await mounted.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })

  it('marks an unreadable config file as missing', async () => {
    const root = new Context()
    const server = new FakeWebServer(root)
    const file = join(await tempDirectory(), 'not-there.yaml')
    const mounted = mount(root, server, { file, source: () => [] })
    await mounted

    const status = await statusOf(PATH, server)
    expect(status.instances[0]?.state).toBe('missing')
    expect(status.instances[0]?.error).toContain('cannot read the file')

    await mounted.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })

  it('rejects a prefix that is not an absolute path', async () => {
    const root = new Context()
    const server = new FakeWebServer(root)
    await expect(
      root.plugin((ctx) => {
        registerProvidersStatusRoute(ctx, {
          prefix: 'relative',
          title: 'more-providers',
          store: stubStore('/missing/more-providers.yaml', {
            loaded: true,
            revision: 1,
            value: undefined,
            error: undefined,
          }),
          source: () => [],
        })
      }),
    ).rejects.toThrow(/absolute path/u)
    expect(server.routes.size).toBe(0)
    await root.fiber.dispose()
  })
})

describe('providers snapshot route through apply', () => {
  afterEach(async () => {
    await disposeTracked()
    await cleanupYamlFiles()
    vi.unstubAllEnvs()
  })

  it('reports each configured route with its accounts and catalog counts', async () => {
    const harness = await createHarness({
      yaml: [
        'providers:',
        '  gateway:',
        '    kind: custom',
        '    displayName: Gateway',
        '    api: openai-responses',
        '    baseURL: https://gateway.invalid/v1',
        `    apiKeyEnv: ${TEST_ENV_KEY}`,
        '    filter:',
        '      exclude:',
        "        - match: '^hidden-'",
        '    models:',
        '      - id: gateway-large',
        '      - id: hidden-model',
        '  chatgpt:',
        '    kind: chatgpt',
        '    enabled: false',
      ].join('\n'),
    })

    const payload = await applyStatus(harness)
    const instance = payload.instances.find((entry) => entry.file === harness.file)
    expect(instance?.state).toBe('ok')
    expect(instance?.providers).toEqual([
      {
        route: 'gateway',
        kind: 'custom',
        auth: 'api-key',
        displayName: 'Gateway',
        enabled: true,
        registered: true,
        accounts: [{ id: 'gateway', displayName: 'Gateway', ready: true, healthy: true }],
        models: {
          discovered: 2,
          effective: 1,
          excluded: ['hidden-model'],
          notIncluded: [],
        },
      },
      {
        route: 'chatgpt',
        kind: 'chatgpt',
        auth: 'oauth',
        displayName: 'ChatGPT (OpenAI)',
        enabled: false,
        registered: false,
        accounts: [],
      },
    ])
  })

  it('reports every pool member in priority order with its runtime health', async () => {
    vi.stubEnv('MORE_PROVIDERS_STATUS_CHEAP_KEY', 'cheap-key')
    const harness = await createHarness({
      yaml: [
        'providers:',
        '  gateway:',
        '    kind: custom',
        '    displayName: Gateway',
        '    api: openai-responses',
        '    baseURL: https://gateway.invalid/v1',
        `    apiKeyEnv: ${TEST_ENV_KEY}`,
        '    models:',
        '      - id: gateway-large',
        '    accounts:',
        '      stable: { displayName: Gateway Stable }',
        '      cheap: { apiKeyEnv: MORE_PROVIDERS_STATUS_CHEAP_KEY }',
        chatgptYaml({ enabled: false }),
      ].join('\n'),
    })

    const payload = await applyStatus(harness)
    const instance = payload.instances.find((entry) => entry.file === harness.file)
    expect(instance?.providers[0]?.accounts).toStrictEqual([
      { id: 'stable', displayName: 'Gateway Stable', ready: true, healthy: true },
      { id: 'cheap', displayName: 'Gateway (cheap)', ready: true, healthy: true },
    ])
  })

  it('keeps an unreadable-key route in the snapshot as unregistered', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt:\n    kind: chatgpt\n    enabled: false\n`,
      envKey: '',
    })

    const payload = await applyStatus(harness)
    const instance = payload.instances.find((entry) => entry.file === harness.file)
    expect(instance?.providers).toEqual([
      {
        route: 'gateway',
        kind: 'custom',
        auth: 'api-key',
        displayName: 'gateway',
        enabled: true,
        registered: false,
        accounts: [{ id: 'gateway', displayName: 'gateway', ready: false }],
        error: 'no readable key',
      },
      {
        route: 'chatgpt',
        kind: 'chatgpt',
        auth: 'oauth',
        displayName: 'ChatGPT (OpenAI)',
        enabled: false,
        registered: false,
        accounts: [],
      },
    ])
  })

  it('lists the ChatGPT OAuth route from its live status view', async () => {
    const harness = await createHarness({ yaml: 'providers:\n  chatgpt:\n    kind: chatgpt\n' })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('chatgpt')),
      'the ChatGPT adapter to mount',
    )

    const payload = await applyStatus(harness)
    const instance = payload.instances.find((entry) => entry.file === harness.file)
    expect(instance?.providers).toEqual([
      {
        route: 'chatgpt',
        kind: 'chatgpt',
        auth: 'oauth',
        displayName: 'ChatGPT (OpenAI)',
        enabled: true,
        registered: true,
        accounts: [],
      },
    ])
  })

  it('renders a mixed snapshot where no route produced models', async () => {
    const root = new Context()
    const web = new FakeWebServer(root)
    const adapters: string[][] = []
    await root.plugin({
      name: 'status-host',
      apply(hostCtx) {
        hostCtx.provide('llm', {
          registerAdapter(providers: string[]) {
            adapters.push(providers)
          },
        } as never)
      },
    })
    const file = await writeYaml(
      [
        'providers:',
        '  gateway:',
        '    kind: custom',
        '    api: openai-responses',
        '    baseURL: https://gateway.invalid/v1',
        '    apiKeyEnv: MORE_PROVIDERS_STATUS_MISSING_KEY',
        '    models:',
        '      - id: gateway-large',
        chatgptYaml(),
      ].join('\n'),
    )
    await root.plugin({ name, inject, apply }, { configFile: file })

    const status = await statusOf(PLUGIN_PATH, web)
    const instance = status.instances.find((entry) => entry.file === file)
    expect(adapters).toEqual([])
    expect(
      instance?.providers.map((provider) => [provider.route, provider.registered, provider.models]),
    ).toEqual([
      ['gateway', false, undefined],
      ['chatgpt', false, undefined],
    ])

    await root.fiber.dispose()
  })

  it('reports an unusable config with no routes', async () => {
    const harness = await createHarness({
      yaml: 'providers:\n  chatgpt:\n    kind: chatgpt\n    bogusField: 1\n',
    })

    const payload = await applyStatus(harness)
    const instance = payload.instances.find((entry) => entry.file === harness.file)
    expect(instance?.state).toBe('invalid')
    expect(instance?.error).toContain('bogusField')
    expect(instance?.providers).toEqual([])
  })
})

async function applyStatus(harness: {
  web: { routes: { def: StubRoute }[] }
}): Promise<ProvidersStatus> {
  const route = harness.web.routes.find((candidate) => candidate.def.path === PLUGIN_PATH)
  if (route === undefined) throw new Error('the providers status route was not registered')
  return (await (await route.def.resource()).json()) as Promise<ProvidersStatus>
}

describe('providers snapshot client view', () => {
  it('indexes routes across instances, keeping the first row for a repeated route', () => {
    const routes = routesById([
      {
        id: 'more-providers#1',
        file: '/a.yaml',
        state: 'ok',
        revision: 1,
        providers: [viewProvider()],
      },
      {
        id: 'more-providers#2',
        file: '/b.yaml',
        state: 'ok',
        revision: 1,
        providers: [
          viewProvider({ registered: false, models: undefined }),
          viewProvider({
            route: 'chatgpt',
            kind: 'chatgpt',
            auth: 'oauth',
            displayName: 'ChatGPT (OpenAI)',
          }),
        ],
      },
    ])
    expect([...routes.keys()]).toEqual(['gateway', 'chatgpt'])
    expect(routes.get('gateway')?.registered).toBe(true)
  })

  it('parses a well-formed body and rejects every malformed shape', () => {
    const instance = {
      id: 'more-providers#1',
      file: '/a.yaml',
      state: 'ok',
      revision: 2,
      providers: [viewProvider({ models: undefined })],
    }
    const body = { instances: [instance] }
    expect(parseSnapshot(body)?.instances[0]?.providers[0]?.route).toBe('gateway')
    expect(parseSnapshot({})).toBeUndefined()
    expect(parseSnapshot({ instances: 'nope' })).toBeUndefined()
    expect(parseSnapshot({ instances: [{ id: 'more-providers#1' }] })).toBeUndefined()

    const withProvider = (provider: Record<string, unknown>) => ({
      instances: [{ ...instance, providers: [provider] }],
    })
    expect(parseSnapshot(withProvider({ ...viewProvider() }))).toBeDefined()
    expect(parseSnapshot({ instances: [{ ...instance, providers: 'nope' }] })).toBeUndefined()
    expect(parseSnapshot(withProvider({ ...viewProvider(), route: undefined }))).toBeUndefined()
    expect(parseSnapshot(withProvider({ ...viewProvider(), kind: 'nope' }))).toBeUndefined()
    expect(parseSnapshot(withProvider({ ...viewProvider(), auth: 'nope' }))).toBeUndefined()
    expect(parseSnapshot({ instances: [{ ...instance, state: 'loading' }] })).toBeUndefined()
    expect(
      parseSnapshot({
        instances: [{ ...instance, providers: [{ ...viewProvider(), models: undefined }] }],
      }),
    ).toBeDefined()
    expect(
      parseSnapshot(
        withProvider({
          ...viewProvider(),
          models: { discovered: 5, effective: 2, excluded: [], notIncluded: [] },
        }),
      ),
    ).toBeDefined()
  })

  it('rejects pool fields whose types do not match the contract', () => {
    const instance = {
      id: 'more-providers#1',
      file: '/a.yaml',
      state: 'ok',
      revision: 2,
      providers: [viewProvider({ accounts: [poolAccount()] })],
    }
    const withAccount = (account: Record<string, unknown>) => ({
      instances: [{ ...instance, providers: [viewProvider({ accounts: [account as never] })] }],
    })
    expect(parseSnapshot({ instances: [instance] })).toBeDefined()
    expect(parseSnapshot(withAccount({ ...poolAccount(), healthy: 'yes' }))).toBeUndefined()
    expect(parseSnapshot(withAccount({ ...poolAccount(), cooldownUntil: 'soon' }))).toBeUndefined()
    expect(
      parseSnapshot(withAccount({ ...poolAccount(), cooldownUntil: Number.NaN })),
    ).toBeUndefined()
    expect(
      parseSnapshot(withAccount({ ...poolAccount(), cooldownUntil: Date.now() + 60_000 })),
    ).toBeDefined()
  })
})

describe('providers snapshot pool view', () => {
  const NOW = 1_000_000

  it('classifies an account as ready, cooling or unavailable', () => {
    expect(accountHealth(poolAccount(), NOW)).toBe('ready')
    expect(accountHealth(poolAccount({ cooldownUntil: NOW + 60_000 }), NOW)).toBe('cooling')
    expect(accountHealth(poolAccount({ healthy: false }), NOW)).toBe('cooling')
    expect(accountHealth(poolAccount({ ready: false }), NOW)).toBe('unavailable')
    expect(accountHealth(poolAccount({ cooldownUntil: NOW - 1 }), NOW)).toBe('ready')
  })

  it('reports cooldown parts only while the deadline is ahead', () => {
    expect(cooldownParts(poolAccount({ cooldownUntil: NOW + 200 }), NOW)).toEqual({
      minutes: 0,
      seconds: 1,
    })
    expect(cooldownParts(poolAccount({ cooldownUntil: NOW + 200_000 }), NOW)).toEqual({
      minutes: 3,
      seconds: 20,
    })
    expect(cooldownParts(poolAccount({ cooldownUntil: NOW }), NOW)).toBeUndefined()
    expect(cooldownParts(poolAccount({ cooldownUntil: NOW - 5 }), NOW)).toBeUndefined()
    expect(cooldownParts(poolAccount(), NOW)).toBeUndefined()
  })
})

describe('providers snapshot live payload', () => {
  const payload = {
    instances: [
      {
        id: 'more-providers#1',
        file: '/home/test/.dsh/more-providers.yaml',
        state: 'ok',
        revision: 1,
        providers: [
          {
            route: 'zai-coding-cn',
            kind: 'builtin',
            auth: 'api-key',
            displayName: 'zai-coding-cn',
            enabled: true,
            registered: true,
            accounts: [
              { id: 'zai-coding-cn', displayName: 'zai-coding-cn', ready: true, healthy: true },
            ],
            models: { discovered: 4, effective: 4, excluded: [], notIncluded: [] },
          },
          {
            route: 'mdkj',
            kind: 'custom',
            auth: 'api-key',
            displayName: 'MDKJ',
            enabled: true,
            registered: true,
            accounts: [
              { id: 'stable', displayName: 'MDKJ Stable', ready: true, healthy: true },
              { id: 'cheap', displayName: 'MDKJ Cheap', ready: true, healthy: true },
            ],
            models: {
              discovered: 6,
              effective: 5,
              excluded: ['gpt-6.1-terra'],
              notIncluded: [],
            },
          },
          {
            route: 'chatgpt',
            kind: 'chatgpt',
            auth: 'oauth',
            displayName: 'ChatGPT (OpenAI)',
            enabled: true,
            registered: true,
            accounts: [],
          },
        ],
      },
    ],
  }

  it('parses the payload a real instance serves', () => {
    const snapshot = parseSnapshot(payload)
    expect(snapshot?.instances).toHaveLength(1)
    const routes = routesById(snapshot?.instances ?? [])
    expect([...routes.keys()]).toEqual(['zai-coding-cn', 'mdkj', 'chatgpt'])
    const mdkj = routes.get('mdkj')
    expect(mdkj?.displayName).toBe('MDKJ')
    expect(mdkj?.registered).toBe(true)
    expect(mdkj?.models?.effective).toBe(5)
    expect(mdkj?.accounts.map((account) => account.displayName)).toEqual([
      'MDKJ Stable',
      'MDKJ Cheap',
    ])
    expect(mdkj?.accounts.every((account) => accountHealth(account, Date.now()) === 'ready')).toBe(
      true,
    )
    expect(routes.get('chatgpt')?.displayName).toBe('ChatGPT (OpenAI)')
    expect(routes.get('chatgpt')?.models).toBeUndefined()
  })
})

describe('providers snapshot applied revision', () => {
  const base = {
    id: 'more-providers#1',
    file: '/a.yaml',
    state: 'ok' as const,
    revision: 3,
    providers: [],
  }

  it('accepts a missing, equal or older applied revision', () => {
    expect(parseSnapshot({ instances: [base] })?.instances[0]?.appliedRevision).toBeUndefined()
    expect(
      parseSnapshot({ instances: [{ ...base, appliedRevision: 3 }] })?.instances[0]
        ?.appliedRevision,
    ).toBe(3)
    expect(
      parseSnapshot({ instances: [{ ...base, appliedRevision: 2 }] })?.instances[0]
        ?.appliedRevision,
    ).toBe(2)
    expect(parseSnapshot({ instances: [{ ...base, appliedRevision: 'soon' }] })).toBeUndefined()
    expect(parseSnapshot({ instances: [{ ...base, appliedRevision: Number.NaN }] })).toBeUndefined()
  })

  it('names the serving revision only while it lags the file revision', () => {
    expect(servingRevision(base)).toBeUndefined()
    expect(servingRevision({ ...base, appliedRevision: 3 })).toBeUndefined()
    expect(servingRevision({ ...base, appliedRevision: 2 })).toBe(2)
  })
})
