/**
 * The account pool's runtime contract: priority, per-model coverage, session stickiness,
 * exponential cooldowns, and the key/accounts surface built on top of it.
 * @module dsh-more-providers/test/pool
 */
import { Context } from '@deepseek-ai/cordis'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { ProviderKeys } from '../src/keys.js'
import type { KeySource } from '../src/keys.js'
import { AccountPool, attemptedAccount, withAttemptAccount } from '../src/providers/pool.js'
import type { PoolAccount } from '../src/providers/pool.js'
import { buildRoutes } from '../src/providers/registry.js'
import { toProviderSpecs } from '../src/providers/spec.js'

const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined }
const MODELS_URL = 'https://pool.invalid/v1/models'

/** Which account a stubbed catalog request belongs to, by its bearer key. */
function catalogFor(request: RequestInit | undefined): string[] {
  const authorization = new Headers(request?.headers).get('authorization')
  if (authorization?.endsWith('key-a') === true) return ['shared-model', 'a-only']
  if (authorization?.endsWith('key-b') === true) return ['shared-model', 'b-only']
  return []
}
const ENV_A = 'MORE_PROVIDERS_POOL_A'
const ENV_B = 'MORE_PROVIDERS_POOL_B'

function sourceEnv(name: string): KeySource {
  return { kind: 'env', name }
}

function account(id: string, env: string): PoolAccount {
  return { id, displayName: id, keySource: sourceEnv(env) }
}

function failure(code: string, extra: Partial<LlmFailure> = {}): LlmFailure {
  return { message: code, code, ...extra }
}

function healthOf(pool: AccountPool, id: string) {
  return pool.snapshot().accounts.find((entry) => entry.id === id)
}

describe('AccountPool: priority and per-model coverage', () => {
  const pool = new AccountPool({
    route: 'mdkj',
    accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
    coverage: new Map([
      ['gpt-6.1-sol', ['stable', 'cheap']],
      ['gpt-6.1-cheap-only', ['cheap']],
    ]),
  })

  it('prefers the highest-priority account that covers the model', () => {
    expect(pool.acquire({ model: 'gpt-6.1-sol' })?.id).toBe('stable')
    expect(pool.acquire({ model: 'gpt-6.1-cheap-only' })?.id).toBe('cheap')
  })

  it('offers no account for a model outside the coverage map', () => {
    expect(pool.acquire({ model: 'unknown-model' })).toBeUndefined()
  })

  it('reports priority order through preferred()', () => {
    expect(pool.preferred()?.id).toBe('stable')
  })
})

describe('AccountPool: session stickiness', () => {
  it('keeps one session on its account across calls', () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
      coverage: new Map([['gpt-6.1-sol', ['stable', 'cheap']]]),
    })

    expect(pool.acquire({ sessionId: 's1', model: 'gpt-6.1-sol' })?.id).toBe('stable')
    expect(pool.acquire({ sessionId: 's2', model: 'gpt-6.1-sol' })?.id).toBe('stable')
    pool.markFailure('stable', failure('AUTH'))
    expect(pool.acquire({ sessionId: 's1', model: 'gpt-6.1-sol' })?.id).toBe('cheap')
    pool.markSuccess('stable')
    expect(pool.acquire({ sessionId: 's1', model: 'gpt-6.1-sol' })?.id).toBe('cheap')
    expect(pool.acquire({ sessionId: 's3', model: 'gpt-6.1-sol' })?.id).toBe('stable')
  })

  it('ignores session state for a one-off call', () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
      coverage: new Map([['gpt-6.1-sol', ['stable', 'cheap']]]),
    })
    pool.acquire({ sessionId: 's1', model: 'gpt-6.1-sol' })
    expect(pool.acquire({ model: 'gpt-6.1-sol' })?.id).toBe('stable')
  })
})

describe('AccountPool: cooldowns', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cools an account down exponentially from five minutes to one hour', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
      coverage: new Map([['m', ['stable', 'cheap']]]),
    })

    const durations: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.setSystemTime(new Date(Date.now() + (durations.at(-1) ?? 0) + 1))
      pool.markFailure('stable', failure('AUTH'))
      const until = healthOf(pool, 'stable')?.cooldownUntil
      durations.push((until ?? 0) - Date.now())
    }

    expect(durations).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000, 40 * 60_000, 60 * 60_000])
    expect(healthOf(pool, 'stable')?.healthy).toBe(false)
    expect(healthOf(pool, 'cheap')?.healthy).toBe(true)
  })

  it('moves traffic off a cooling account and back once it recovers', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
      coverage: new Map([['m', ['stable', 'cheap']]]),
    })

    pool.markFailure('stable', failure('AUTH'))
    expect(pool.acquire({ model: 'm' })?.id).toBe('cheap')
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1))
    expect(pool.acquire({ model: 'm' })?.id).toBe('stable')
  })

  it('respects providerRetryAfterMs and clears on success', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A)],
      coverage: new Map([['m', ['stable']]]),
    })

    pool.markFailure('stable', failure('QUOTA', { providerRetryAfterMs: 90_000 }))
    expect((healthOf(pool, 'stable')?.cooldownUntil ?? 0) - Date.now()).toBe(90_000)
    pool.markSuccess('stable')
    expect(healthOf(pool, 'stable')).toEqual({
      id: 'stable',
      displayName: 'stable',
      healthy: true,
    })
  })

  it('does not cool an account on transient or terminal failures', () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A)],
      coverage: new Map([['m', ['stable']]]),
    })

    pool.markFailure('stable', failure('RATE_LIMIT'))
    pool.markFailure('stable', failure('UNKNOWN_MODEL'))
    expect(healthOf(pool, 'stable')?.healthy).toBe(true)
    expect(healthOf(pool, 'stable')?.cooldownUntil).toBeUndefined()
  })

  it('still offers the highest-priority account when every account is cooling', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
      coverage: new Map([['m', ['stable', 'cheap']]]),
    })

    pool.markFailure('stable', failure('AUTH'))
    pool.markFailure('cheap', failure('AUTH'))
    expect(pool.acquire({ model: 'm' })?.id).toBe('stable')
    expect(pool.preferred()?.id).toBe('stable')
  })

  it('skips the accounts this request already tried', () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [account('stable', ENV_A), account('cheap', ENV_B)],
      coverage: new Map([['m', ['stable', 'cheap']]]),
    })

    expect(pool.acquire({ model: 'm', exclude: ['stable'] })?.id).toBe('cheap')
    expect(pool.acquire({ model: 'm', exclude: ['stable', 'cheap'] })).toBeUndefined()
  })
})

/** A keys service over a two-account pool with both env keys readable. */
function mountKeys() {
  vi.stubEnv(ENV_A, 'key-a')
  vi.stubEnv(ENV_B, 'key-b')
  const members = [account('stable', ENV_A), account('cheap', ENV_B)]
  const pool = new AccountPool({
    route: 'mdkj',
    accounts: members,
    coverage: new Map([['m', ['stable', 'cheap']]]),
  })
  const keys = new ProviderKeys(new Context(), new Map([['mdkj', { accounts: members, pool }]]))
  return { keys, pool, members }
}

describe('providerKeys: pooled key and account surface', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('serves the highest-priority key while every account is healthy', () => {
    const { keys } = mountKeys()
    expect(keys.key('mdkj')).toBe('key-a')
    expect(keys.key('unknown')).toBeUndefined()
  })

  it('keeps serving the highest-priority key when every account is cooling', () => {
    const { keys, pool } = mountKeys()
    pool.markFailure('stable', failure('AUTH'))
    pool.markFailure('cheap', failure('AUTH'))

    expect(pool.snapshot().accounts.every((entry) => !entry.healthy)).toBe(true)
    expect(keys.key('mdkj')).toBe('key-a')
  })

  it('serves the attempt account while one is in flight', () => {
    const { keys, members } = mountKeys()
    const cheap = members[1]
    if (cheap === undefined) throw new Error('missing pool member')
    expect(withAttemptAccount({ route: 'mdkj', account: cheap }, () => keys.key('mdkj'))).toBe(
      'key-b',
    )
    expect(attemptedAccount('mdkj')).toBeUndefined()
  })

  it('reports pool members with key presence and cooldown, without the key itself', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { keys, pool } = mountKeys()
    pool.markFailure('stable', failure('AUTH'))

    expect(keys.accounts('mdkj')).toStrictEqual([
      {
        id: 'stable',
        displayName: 'stable',
        keyPresent: true,
        healthy: false,
        cooldownUntil: Date.now() + 5 * 60_000,
      },
      { id: 'cheap', displayName: 'cheap', keyPresent: true, healthy: true },
    ])
    expect(JSON.stringify(keys.accounts('mdkj'))).not.toContain('key-a')
    expect(keys.accounts('unknown')).toEqual([])
  })

  it('keeps a member with no readable key visible but out of the rotation', () => {
    vi.stubEnv(ENV_A, '')
    vi.stubEnv(ENV_B, 'key-b')
    const members = [account('stable', ENV_A), account('cheap', ENV_B)]
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: members,
      coverage: new Map([['m', ['stable', 'cheap']]]),
    })
    const keys = new ProviderKeys(new Context(), new Map([['mdkj', { accounts: members, pool }]]))

    expect(keys.accounts('mdkj').map((entry) => [entry.id, entry.keyPresent])).toEqual([
      ['stable', false],
      ['cheap', true],
    ])
  })
})

/** Build one pooled custom route through the registry with stubbed catalogs. */
async function buildPooled(extra: Record<string, unknown> = {}) {
  vi.stubEnv(ENV_A, 'key-a')
  vi.stubEnv(ENV_B, 'key-b')
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    urls.push(url)
    return new Response(JSON.stringify({ data: catalogFor(init).map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const resolved = resolveConfig({
    providers: {
      mdkj: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://pool.invalid/v1',
        modelsURL: MODELS_URL,
        accounts: {
          stable: { apiKeyEnv: ENV_A },
          cheap: { apiKeyEnv: ENV_B },
        },
        ...extra,
      },
    },
  })
  const built = await buildRoutes(toProviderSpecs(resolved), LOG)
  return { built, urls }
}

/** Every account the pool would offer for one model, in priority order. */
function candidatesOf(pool: AccountPool, model: string): string[] {
  const tried: string[] = []
  for (;;) {
    const member = pool.acquire({ model, exclude: tried })
    if (member === undefined) return tried
    tried.push(member.id)
  }
}

describe('registry: pooled catalogs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('fetches every account catalog concurrently and unions the models', async () => {
    const { built, urls } = await buildPooled()

    expect(urls).toHaveLength(2)
    expect(built.profiles.has('mdkj')).toBe(true)
    const models = built.profiles
      .get('mdkj')
      ?.piProvider?.getModels()
      .map((model) => model.id)
    expect(models).toStrictEqual(['shared-model', 'a-only', 'b-only'])
    expect(built.reports.get('mdkj')?.models).toEqual({
      discovered: 3,
      effective: 3,
      excluded: [],
      notIncluded: [],
    })
    const pool = built.accounts.get('mdkj')?.pool
    expect(pool?.snapshot().accounts.map((entry) => entry.id)).toEqual(['stable', 'cheap'])
  })

  it('covers every registered model with at least one pool account', async () => {
    const { built } = await buildPooled()
    const pool = built.accounts.get('mdkj')?.pool
    const models = built.profiles.get('mdkj')?.piProvider?.getModels() ?? []
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(pool.acquire({ model: model.id }), model.id).toBeDefined()
    }
  })

  it('routes each model only to the accounts that offer it', async () => {
    const { built } = await buildPooled()
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(pool.acquire({ model: 'shared-model' })?.id).toBe('stable')
    expect(pool.acquire({ model: 'a-only' })?.id).toBe('stable')
    expect(pool.acquire({ model: 'b-only' })?.id).toBe('cheap')
    expect(pool.acquire({ model: 'b-only', exclude: ['cheap'] })).toBeUndefined()
  })

  it('offers both accounts for a model they both list, and fails over between them', async () => {
    const { built } = await buildPooled()
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(candidatesOf(pool, 'shared-model')).toEqual(['stable', 'cheap'])
    expect(pool.acquire({ model: 'shared-model', exclude: ['stable'] })?.id).toBe('cheap')
  })

  it('offers exactly one account for a model only one of them lists', async () => {
    const { built } = await buildPooled()
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(candidatesOf(pool, 'a-only')).toEqual(['stable'])
    expect(candidatesOf(pool, 'b-only')).toEqual(['cheap'])
  })

  it('drops an account whose catalog failed and has no static fallback', async () => {
    vi.stubEnv(ENV_A, 'key-a')
    vi.stubEnv(ENV_B, 'key-b')
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization?.endsWith('key-b') === true) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ data: [{ id: 'a-only' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://pool.invalid/v1',
          modelsURL: MODELS_URL,
          accounts: { stable: { apiKeyEnv: ENV_A }, cheap: { apiKeyEnv: ENV_B } },
        },
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)

    expect(built.reports.get('mdkj')?.registered).toBe(true)
    expect(built.reports.get('mdkj')?.catalogError).toBe('model catalog returned 503')
    expect(
      built.accounts
        .get('mdkj')
        ?.pool?.snapshot()
        .accounts.map((entry) => entry.id),
    ).toEqual(['stable'])
  })

  it('keeps a failed account out of coverage instead of lending it another account', async () => {
    vi.stubEnv(ENV_A, 'key-a')
    vi.stubEnv(ENV_B, 'key-b')
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization?.endsWith('key-b') === true) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ data: [{ id: 'a-only' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://pool.invalid/v1',
          modelsURL: MODELS_URL,
          accounts: { stable: { apiKeyEnv: ENV_A }, cheap: { apiKeyEnv: ENV_B } },
        },
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(candidatesOf(pool, 'a-only')).toEqual(['stable'])
    expect(pool.acquire({ model: 'b-only' })).toBeUndefined()
    expect(
      built.profiles
        .get('mdkj')
        ?.piProvider?.getModels()
        .map((model) => model.id),
    ).toEqual(['a-only'])
  })

  it('never lends a static-only model to the pool when the catalogs succeeded', async () => {
    vi.stubEnv(ENV_A, 'key-a')
    vi.stubEnv(ENV_B, 'key-b')
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'discovered-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://pool.invalid/v1',
          modelsURL: MODELS_URL,
          models: [{ id: 'static-only' }],
          accounts: { stable: { apiKeyEnv: ENV_A }, cheap: { apiKeyEnv: ENV_B } },
        },
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(candidatesOf(pool, 'discovered-model')).toEqual(['stable', 'cheap'])
    expect(pool.acquire({ model: 'static-only' })).toBeUndefined()
    expect(
      built.profiles
        .get('mdkj')
        ?.piProvider?.getModels()
        .map((model) => model.id),
    ).toEqual(['discovered-model'])
  })

  it('serves every static model from the whole pool when no catalog answers', async () => {
    vi.stubEnv(ENV_A, 'key-a')
    vi.stubEnv(ENV_B, 'key-b')
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://pool.invalid/v1',
          modelsURL: MODELS_URL,
          models: [{ id: 'static-only', contextWindow: 128000 }],
          accounts: { stable: { apiKeyEnv: ENV_A }, cheap: { apiKeyEnv: ENV_B } },
        },
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(built.reports.get('mdkj')?.registered).toBe(true)
    expect(candidatesOf(pool, 'static-only')).toEqual(['stable', 'cheap'])
  })

  it('keeps a failed account in the pool when static models cover it', async () => {
    vi.stubEnv(ENV_A, 'key-a')
    vi.stubEnv(ENV_B, 'key-b')
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization?.endsWith('key-b') === true) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ data: [{ id: 'shared-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://pool.invalid/v1',
          modelsURL: MODELS_URL,
          models: [{ id: 'shared-model' }, { id: 'static-only' }],
          accounts: { stable: { apiKeyEnv: ENV_A }, cheap: { apiKeyEnv: ENV_B } },
        },
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)
    const pool = built.accounts.get('mdkj')?.pool
    if (pool === undefined) throw new Error('the route did not build a pool')

    expect(pool.snapshot().accounts.map((entry) => entry.id)).toEqual(['stable', 'cheap'])
    expect(pool.acquire({ model: 'shared-model' })?.id).toBe('stable')
    expect(pool.acquire({ model: 'shared-model', exclude: ['stable'] })?.id).toBe('cheap')
  })

  it('leaves an account without a readable key out of the pool', async () => {
    vi.stubEnv(ENV_A, '')
    vi.stubEnv(ENV_B, 'key-b')
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'shared-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://pool.invalid/v1',
          modelsURL: MODELS_URL,
          accounts: { stable: { apiKeyEnv: ENV_A }, cheap: { apiKeyEnv: ENV_B } },
        },
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)

    expect(built.reports.get('mdkj')?.registered).toBe(true)
    expect(built.accounts.get('mdkj')?.accounts.map((entry) => entry.id)).toEqual(['cheap'])
  })
})
