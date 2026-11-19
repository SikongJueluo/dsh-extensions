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
import {
  TEST_API_KEY,
  TEST_ENV_KEY,
  gatewayYaml,
  adapterFor,
  cleanupYamlFiles,
  createHarness,
  waitFor,
  disposeTracked,
  type Harness,
} from './helpers.js'

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllEnvs()
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
  it('mounts ChatGPT with an empty providers map', async () => {
    const harness = await createHarness({ yaml: 'providers: {}\n' })
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
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt:\n    enabled: false\n`,
    })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('gateway')),
      'the gateway adapter to register',
    )

    expect(adapterFor(harness.llm, 'chatgpt')).toBeUndefined()
    expect(harness.ctx.get('oauthProviders')).toBeInstanceOf(OAuthProvidersService)
    expect((harness.ctx.get('oauthProviders') as OAuthProvidersService).providers()).toEqual([])
    const providerKeys = harness.ctx.get('providerKeys') as {
      key(route: string): string | undefined
    }
    expect(providerKeys).toBeDefined()
    expect(providerKeys.key('gateway')).toBe(TEST_API_KEY)
    expect(providerKeys.key('chatgpt')).toBeUndefined()
  })

  it('leaves a keyless route dormant without blocking ChatGPT', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt: {}\n`,
      envKey: '',
    })
    await awaitMount(harness)

    expect(adapterFor(harness.llm, 'gateway')).toBeUndefined()
    expect(adapterFor(harness.llm, 'chatgpt')).toBeDefined()
  })

  it('disables ChatGPT without deleting the existing grant', async () => {
    const harness = await createHarness({
      yaml: `providers:\n  chatgpt:\n    enabled: false\n`,
    })
    await new Promise((settle) => {
      setTimeout(settle, 50)
    })

    expect(adapterFor(harness.llm, 'chatgpt')).toBeUndefined()
    expect((harness.ctx.get('oauthProviders') as OAuthProvidersService).providers()).toEqual([])
    expect(harness.credentials.records.get('oauth-providers/chatgpt')).toMatchObject({
      kind: 'grant',
      payload: { access: 'test-access-token' },
    })
  })

  it('serves chatgpt tokens from the preserved oauth-providers record', async () => {
    const harness = await createHarness({ yaml: 'providers: {}\n' })
    await awaitMount(harness)
    const oauth = harness.ctx.get('oauthProviders') as OAuthProvidersService

    const token = await oauth.token('chatgpt')
    expect(token).toMatchObject({ access: 'test-access-token', accountId: 'acct-1' })
  })
})

describe('apply: browser sign-in channel', () => {
  it('serves the signed-in ChatGPT card from the preserved grant', async () => {
    const harness = await createHarness({ yaml: 'providers: {}\n' })
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
    const harness = await createHarness({ yaml: 'providers: {}\n', chatgptGrant: false })
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
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt:\n    bogusField: 1\n`,
    })

    expect(harness.llm.adapters).toEqual([])
    expect(harness.ctx.get('oauthProviders')).toBeUndefined()
    expect(
      harness.ctx.get('providerKeys') as { key(r: string): unknown } | undefined,
    ).toBeUndefined()
  })

  it('keeps the status route serving the error to the browser half', async () => {
    const harness = await createHarness({
      yaml: `providers:\n${gatewayYaml()}\n  chatgpt:\n    bogusField: 1\n`,
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
    expect(mine).toMatchObject({ state: 'invalid', recovery: 'restart' })
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
    const harness = await createHarness({ yaml: 'providers: {}\n' })
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
    const harness = await createHarness({ yaml: 'providers: {}\n' })
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
