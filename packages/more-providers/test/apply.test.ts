/**
 * Startup contract of the merged plugin: default-on ChatGPT, strict fail-closed configuration, preserved host surfaces, and the status route that keeps serving the error to the browser half.
 * @module dsh-more-providers/test/apply
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { ConfigStatusPayload } from '@dsh-extensions/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_CHANNEL } from '../src/identity.js'
import { OAuthProvidersService } from '../src/oauth/service.js'
import { resolveConfig } from '../src/config.js'
import { buildRoutes } from '../src/providers/registry.js'
import { toProviderSpecs } from '../src/providers/spec.js'
import type { RouteBuildReport } from '../src/providers.js'
import {
  TEST_API_KEY,
  TEST_ENV_KEY,
  gatewayYaml,
  adapterFor,
  cleanupYamlFiles,
  chatgptYaml,
  createHarness,
  waitFor,
  disposeTracked,
  type Harness,
} from './helpers.js'

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Wait until the credentials-driven ChatGPT mount has happened (or not). */
async function awaitMount(harness: Harness): Promise<void> {
  await waitFor(
    () => harness.llm.adapters.some((entry) => entry.providers.includes('chatgpt')),
    'the ChatGPT adapter to mount',
  )
}

/** One provider row as the browser sign-in channel serves it. */
interface ProviderRow {
  id: string
  label?: string
  signedIn?: boolean
}

/** POST `providers` through the HTTP route the plugin registered and return the RPC result. */
async function listChannelProviders(harness: Harness): Promise<{
  ok: boolean
  value?: { providers?: ProviderRow[] }
  error?: { code?: string; message?: string }
}> {
  await waitFor(
    () => harness.web.routes.some((route) => route.def.path === RPC_CHANNEL),
    'the sign-in channel route',
  )
  const route = harness.web.routes.find((entry) => entry.def.path === RPC_CHANNEL)
  if (route === undefined || !('handler' in route.def))
    throw new Error('the sign-in channel route was not registered')
  const req = Readable.from([
    Buffer.from(
      JSON.stringify({
        type: 'client-request',
        rpcId: 'test-providers',
        method: 'providers',
        payload: {},
      }),
    ),
  ]) as unknown as IncomingMessage
  req.method = 'POST'
  req.url = `${RPC_CHANNEL}/providers`
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
  expect(captured.status).toBe(200)
  return (
    JSON.parse(captured.body) as {
      result: {
        ok: boolean
        value?: { providers?: ProviderRow[] }
        error?: { code?: string; message?: string }
      }
    }
  ).result
}

describe('apply: ChatGPT default-on and API-key routes', () => {
  it('registers nothing for an empty providers map', async () => {
    const harness = await createHarness({ yaml: 'providers: {}\n' })
    await new Promise((settle) => {
      setTimeout(settle, 50)
    })

    expect(harness.llm.adapters).toEqual([])
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
  })

  it('mounts ChatGPT when the document configures it', async () => {
    const harness = await createHarness({ yaml: `providers:\n${chatgptYaml()}\n` })
    await awaitMount(harness)

    expect(adapterFor(harness.llm, 'chatgpt')).toBeDefined()
    const oauth = harness.ctx.get('oauthProviders') as OAuthProvidersService
    expect(oauth).toBeInstanceOf(OAuthProvidersService)
    expect(oauth.providers()).toEqual(['chatgpt'])
    expect(harness.llm.adapters).toHaveLength(1)
    expect(harness.llm.discoveries.has('more-providers')).toBe(true)
  })

  it('registers the API-key route and serves its key from providerKeys', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n${chatgptYaml({ enabled: false })}\n`,
    })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('gateway')),
      'the gateway adapter to register',
    )

    expect(adapterFor(harness.llm, 'chatgpt')).toBeUndefined()
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
    const providerKeys = harness.ctx.get('providerKeys') as {
      key(route: string): string | undefined
    }
    expect(providerKeys).toBeDefined()
    expect(providerKeys.key('gateway')).toBe(TEST_API_KEY)
    expect(providerKeys.key('chatgpt')).toBeUndefined()
  })

  it('leaves a keyless route dormant without blocking ChatGPT', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n${chatgptYaml()}\n`,
      envKey: '',
    })
    await awaitMount(harness)

    expect(adapterFor(harness.llm, 'gateway')).toBeUndefined()
    expect(adapterFor(harness.llm, 'chatgpt')).toBeDefined()
  })

  it('disables ChatGPT without deleting the existing grant', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${chatgptYaml({ enabled: false })}\n`,
    })
    await new Promise((settle) => {
      setTimeout(settle, 50)
    })

    expect(adapterFor(harness.llm, 'chatgpt')).toBeUndefined()
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
    expect(harness.credentials.records.get('oauth-providers/chatgpt')).toMatchObject({
      kind: 'grant',
      payload: { access: 'test-access-token' },
    })
  })

  it('serves chatgpt tokens from the preserved oauth-providers record', async () => {
    const harness = await createHarness({ yaml: `providers:\n${chatgptYaml()}\n` })
    await awaitMount(harness)
    const oauth = harness.ctx.get('oauthProviders') as OAuthProvidersService

    const token = await oauth.token('chatgpt')
    expect(token).toMatchObject({ access: 'test-access-token', accountId: 'acct-1' })
  })
})

describe('apply: browser sign-in channel', () => {
  it('serves the signed-in ChatGPT card from the preserved grant', async () => {
    const harness = await createHarness({ yaml: `providers:\n${chatgptYaml()}\n` })
    await awaitMount(harness)

    const result = await listChannelProviders(harness)
    expect(result).toEqual({
      ok: true,
      value: {
        providers: [
          expect.objectContaining({ id: 'chatgpt', label: 'ChatGPT (OpenAI)', signedIn: true }),
        ],
      },
    })
  })

  it('serves the ChatGPT card as signed out without a grant', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${chatgptYaml()}\n`,
      chatgptGrant: false,
    })
    await awaitMount(harness)

    const result = await listChannelProviders(harness)
    expect(result).toEqual({
      ok: true,
      value: { providers: [expect.objectContaining({ id: 'chatgpt', signedIn: false })] },
    })
  })
})

describe('apply: fail-closed configuration', () => {
  it('registers no routes and no services for an invalid document', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt:\n    kind: chatgpt\n    bogusField: 1\n`,
    })

    expect(harness.llm.adapters).toEqual([])
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
    expect(
      harness.ctx.get('providerKeys') as { key(r: string): unknown } | undefined,
    ).toBeUndefined()
  })

  it('keeps the status route serving the error to the browser half', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt:\n    kind: chatgpt\n    bogusField: 1\n`,
    })
    const status = harness.web.routes.find(
      (route) => route.def.path === '/dsh-more-providers/config-status',
    )
    const resource =
      status !== undefined && 'resource' in status.def ? status.def.resource : undefined
    if (resource === undefined) throw new Error('the config-status route was not registered')
    const response = await resource()
    const payload = (await response.json()) as ConfigStatusPayload
    const mine = payload.instances.find((instance) => instance.file === harness.file)
    expect(mine).toMatchObject({ state: 'invalid', recovery: 'auto' })
    expect(mine?.error).toContain('bogusField')
  })

  it('rejects a provider that claims the reserved chatgpt route', async () => {
    const harness = await createHarness({
      yaml: [
        'providers:',
        '  evil:',
        '    kind: custom',
        '    api: openai-responses',
        '    baseURL: https://gateway.invalid/v1',
        `    apiKeyEnv: ${TEST_ENV_KEY}`,
        '    models:',
        '      - id: gateway-large',
        '    accounts:',
        '      a:',
        '        routeId: chatgpt',
      ].join('\n'),
    })

    expect(harness.llm.adapters).toEqual([])
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
  })
})

describe('apply: credential-scope events survive the merge', () => {
  it('emits llm/adapters-updated for oauth-providers records', async () => {
    const harness = await createHarness({ yaml: `providers:\n${chatgptYaml()}\n` })
    await awaitMount(harness)
    const updates: unknown[] = []
    harness.ctx.on('llm/adapters-updated', () => {
      updates.push(true)
    })

    await harness.credentials.service.modifyRecord(
      credentialKey('oauth-providers', 'chatgpt'),
      async () => ({
        kind: 'grant',
        payload: { access: 'rotated', refresh: 'r', expires: Date.now() + 3e11, accountId: 'a' },
      }),
    )
    await new Promise((settle) => {
      setTimeout(settle, 20)
    })
    expect(updates.length).toBeGreaterThan(0)
  })

  it('ignores record updates from other scopes', async () => {
    const harness = await createHarness({ yaml: `providers:\n${chatgptYaml()}\n` })
    await awaitMount(harness)
    let updates = 0
    harness.ctx.on('llm/adapters-updated', () => {
      updates += 1
    })

    await harness.credentials.service.modifyRecord(
      credentialKey('some-other-plugin', 'chatgpt'),
      async () => ({
        kind: 'grant',
        payload: { access: 'other', refresh: 'r', expires: Date.now() + 3e11 },
      }),
    )
    await new Promise((settle) => {
      setTimeout(settle, 20)
    })
    expect(updates).toBe(0)
  })
})

describe('apply: a route the filter empties', () => {
  it('registers nothing while ChatGPT stays off', async () => {
    const harness = await createHarness({
      yaml: [
        'providers:',
        gatewayYaml(),
        '    filter:',
        '      include:',
        "        - match: '^nothing$'",
        chatgptYaml({ enabled: false }),
      ].join('\n'),
    })
    await new Promise((settle) => {
      setTimeout(settle, 50)
    })

    expect(harness.llm.adapters).toEqual([])
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
  })
})

/** Gateway provider document with the two static models the report tests count. */
function gatewayDocument(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    apiKeyEnv: TEST_ENV_KEY,
    models: [{ id: 'gateway-large' }, { id: 'gateway-mini' }],
    ...extra,
  }
}

describe('apply: build reports', () => {
  const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const MODELS_URL = 'https://gateway.invalid/v1/models'

  async function reportsFor(
    providers: Record<string, unknown>,
  ): Promise<ReadonlyMap<string, RouteBuildReport>> {
    const { reports } = await buildRoutes(toProviderSpecs(resolveConfig({ providers })), LOG)
    return reports
  }

  it('reports the counts of a registered route', async () => {
    vi.stubEnv(TEST_ENV_KEY, TEST_API_KEY)
    const reports = await reportsFor({
      gateway: gatewayDocument({ filter: { exclude: [{ match: '-mini$' }] } }),
    })

    expect(reports.get('gateway')).toStrictEqual({
      route: 'gateway',
      registered: true,
      models: {
        discovered: 2,
        effective: 1,
        excluded: ['gateway-mini'],
        notIncluded: [],
      },
    })
  })

  it('reports a route the filter empties as unregistered', async () => {
    vi.stubEnv(TEST_ENV_KEY, TEST_API_KEY)
    const reports = await reportsFor({
      gateway: gatewayDocument({ filter: { include: [{ match: '^nothing$' }] } }),
    })

    expect(reports.get('gateway')).toStrictEqual({
      route: 'gateway',
      registered: false,
      models: {
        discovered: 2,
        effective: 0,
        excluded: [],
        notIncluded: ['gateway-large', 'gateway-mini'],
      },
      error: 'every model was filtered out',
    })
  })

  it('keeps the catalog failure next to a successful static fallback', async () => {
    vi.stubEnv(TEST_ENV_KEY, TEST_API_KEY)
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    const { profiles, reports } = await buildRoutes(
      toProviderSpecs(
        resolveConfig({ providers: { gateway: gatewayDocument({ modelsURL: MODELS_URL }) } }),
      ),
      LOG,
    )

    expect(reports.get('gateway')).toStrictEqual({
      route: 'gateway',
      registered: true,
      models: {
        discovered: 2,
        effective: 2,
        excluded: [],
        notIncluded: [],
      },
      catalogError: 'model catalog returned 503',
    })
    expect(
      profiles
        .get('gateway')
        ?.piProvider?.getModels()
        .map((model) => model.id),
    ).toEqual(['gateway-large', 'gateway-mini'])
  })

  it('reports a keyless route without running the catalog', async () => {
    vi.stubEnv(TEST_ENV_KEY, '')
    const reports = await reportsFor({ gateway: gatewayDocument() })

    expect(reports.get('gateway')).toStrictEqual({
      route: 'gateway',
      registered: false,
      error: 'no readable key',
    })
  })

  it('reports every configured route in configuration order', async () => {
    vi.stubEnv(TEST_ENV_KEY, TEST_API_KEY)
    const reports = await reportsFor({
      first: gatewayDocument(),
      second: { kind: 'builtin', catalog: 'zai-coding-cn', apiKeyEnv: TEST_ENV_KEY },
    })

    expect([...reports.keys()]).toEqual(['first', 'second'])
    expect(reports.get('second')?.registered).toBe(true)
    expect(reports.get('second')?.models?.effective).toBeGreaterThan(0)
  })
})
