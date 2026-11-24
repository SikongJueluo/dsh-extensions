/**
 * Failover contract: account selection per attempt, the two failure shapes, the
 * no-retry-after-first-chunk rule, and the exact upstream call count.
 * @module dsh-more-providers/test/failover
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FailoverPiAiAdapter } from '../src/providers/failover.js'
import { AccountPool, attemptedAccount } from '../src/providers/pool.js'
import type { PoolAccount } from '../src/providers/pool.js'
import {
  collectStream,
  createHarness,
  generateOptions,
  registeredAdapter,
  type Harness,
} from './helpers.js'

const AUTH: PiAiAdapterOptions['auth'] = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  },
  authContext: {
    env: async () => undefined,
    fileExists: async () => false,
  },
}

function member(id: string): PoolAccount {
  return { id, displayName: id, keySource: { kind: 'env', name: `MORE_PROVIDERS_FAILOVER_${id}` } }
}

function usage(inputTokens: number): StreamChunk {
  return { type: 'usage', usage: { inputTokens, outputTokens: 1 } }
}

function textChunk(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text }
}

function finishStop(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } }
}

function finishError(code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message: code, code } } }
}

/** What one streamed attempt yields, or the error it throws. */
type Script = readonly StreamChunk[] | Error | (() => AsyncGenerator<StreamChunk>)

/** The adapter under test plus the accounts its scripted upstream ran under, in call order. */
interface ScriptedAdapter {
  adapter: FailoverPiAiAdapter
  pool: AccountPool
  calls: (string | undefined)[]
}

/** One adapter whose parent stream is scripted per call, so chunk shapes are exact. */
function scriptedAdapter(scripts: Script[], pool: AccountPool): ScriptedAdapter {
  const adapter = new FailoverPiAiAdapter({
    profiles: () => new Map(),
    resolveApiKey: async () => 'key',
    auth: AUTH,
    pools: () => new Map([['mdkj', pool]]),
  })
  const calls: (string | undefined)[] = []
  const body = async function* (): AsyncGenerator<StreamChunk> {
    calls.push(attemptedAccount('mdkj')?.id)
    const script = scripts.shift()
    if (script === undefined) throw new LlmError('no script left', 'PI_AI_ERROR')
    if (script instanceof Error) throw script
    if (typeof script === 'function') yield* script()
    else yield* script
  }
  vi.spyOn(PiAiAdapter.prototype, 'stream').mockImplementation(() => body())
  return { adapter, pool, calls }
}

function twoAccountPool(): AccountPool {
  return new AccountPool({
    route: 'mdkj',
    accounts: [member('stable'), member('cheap')],
    coverage: new Map([['m', ['stable', 'cheap']]]),
  })
}

const OPTIONS: GenerateOptions = { provider: 'mdkj', model: 'm', messages: [] }

/** One user message, the smallest request the adapter accepts. */
function request(): GenerateOptions {
  return generateOptions('mdkj', 'm', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
}

describe('FailoverPiAiAdapter: account-level failures', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries a thrown AUTH error on the next account and marks the first one cooling', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter(
      [new LlmError('bad key', 'AUTH'), [textChunk('ok'), usage(1), finishStop()]],
      pool,
    )

    const { chunks, error } = await collectStream(adapter.stream(OPTIONS))

    expect(error).toBeUndefined()
    expect(calls).toEqual(['stable', 'cheap'])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([textChunk('ok')])
    expect(pool.snapshot().accounts).toStrictEqual([
      expect.objectContaining({ id: 'stable', healthy: false }),
      expect.objectContaining({ id: 'cheap', healthy: true }),
    ])
  })

  it('swallows an in-band error finish and its usage chunk, then serves the next account', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter(
      [
        [usage(999), finishError('QUOTA')],
        [textChunk('ok'), usage(7), finishStop()],
      ],
      pool,
    )

    const { chunks, error } = await collectStream(adapter.stream(OPTIONS))
    const usages = chunks.filter((chunk) => chunk.type === 'usage')

    expect(error).toBeUndefined()
    expect(calls).toEqual(['stable', 'cheap'])
    expect(usages).toStrictEqual([usage(7)])
    expect(chunks.find((chunk) => chunk.type === 'finish')).toStrictEqual(finishStop())
  })

  it('keeps a transient failure out of the cooldown but still switches accounts', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter(
      [new LlmError('rate limited', 'RATE_LIMIT'), [textChunk('ok'), finishStop()]],
      pool,
    )

    await collectStream(adapter.stream(OPTIONS))

    expect(calls).toEqual(['stable', 'cheap'])
    expect(pool.snapshot().accounts.every((entry) => entry.healthy)).toBe(true)
  })
})

const SESSION_BLOCKED =
  'mdkj-gpt API error (403): {"code":"session_blocked_by_cyber_policy","message":"该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session","type":"permission_error"}'

describe('FailoverPiAiAdapter: session-policy refusals', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the block without cooling the account or trying the next one', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter([new LlmError(SESSION_BLOCKED, 'AUTH')], pool)

    const { chunks, error } = await collectStream(adapter.stream(OPTIONS))

    expect(calls).toEqual(['stable'])
    expect(chunks).toEqual([])
    expect((error as Error).message).toContain('session_blocked_by_cyber_policy')
    expect((error as Error).message).toContain('新建会话或换模型')
    expect(pool.snapshot().accounts).toStrictEqual([
      expect.objectContaining({ id: 'stable', healthy: true }),
      expect.objectContaining({ id: 'cheap', healthy: true }),
    ])
  })

  it('forwards a policy refusal that arrives after content without cooling the account', async () => {
    const pool = twoAccountPool()
    const blocked = {
      type: 'finish' as const,
      reason: {
        kind: 'error' as const,
        failure: { message: SESSION_BLOCKED, code: 'AUTH' },
      },
    }
    const { adapter, calls } = scriptedAdapter([[textChunk('partial'), blocked]], pool)

    const { chunks } = await collectStream(adapter.stream(OPTIONS))

    expect(calls).toEqual(['stable'])
    expect(chunks).toStrictEqual([textChunk('partial'), blocked])
    expect(pool.snapshot().accounts).toStrictEqual([
      expect.objectContaining({ id: 'stable', healthy: true }),
      expect.objectContaining({ id: 'cheap', healthy: true }),
    ])
  })
})

describe('FailoverPiAiAdapter: no failover after the first chunk', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards a failure that arrives after content instead of switching accounts', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter(
      [[textChunk('partial'), usage(3), finishError('SERVER')]],
      pool,
    )

    const { chunks } = await collectStream(adapter.stream(OPTIONS))

    expect(calls).toEqual(['stable'])
    expect(chunks).toStrictEqual([textChunk('partial'), usage(3), finishError('SERVER')])
  })

  it('rethrows a mid-stream exception without touching the pool', async () => {
    const pool = twoAccountPool()
    const lateFailure = async function* (): AsyncGenerator<StreamChunk> {
      yield textChunk('partial')
      throw new LlmError('late', 'SERVER')
    }
    const { adapter, calls } = scriptedAdapter([lateFailure], pool)

    const { chunks, error } = await collectStream(adapter.stream(OPTIONS))
    expect(chunks).toEqual([textChunk('partial')])
    expect(error).toMatchObject({ code: 'SERVER' })
    expect(calls).toEqual(['stable'])
    expect(pool.snapshot().accounts.every((entry) => entry.healthy)).toBe(true)
  })
})

describe('FailoverPiAiAdapter: terminal outcomes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws an unknown-model failure without switching accounts', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter([new LlmError('no model', 'UNKNOWN_MODEL')], pool)

    const { error } = await collectStream(adapter.stream(OPTIONS))
    expect(error).toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(calls).toEqual(['stable'])
  })

  it('rejects a model no pool account serves instead of returning an empty stream', async () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [member('stable'), member('cheap')],
      coverage: new Map([['other-model', ['stable', 'cheap']]]),
    })
    const { adapter, calls } = scriptedAdapter([], pool)

    const { chunks, error } = await collectStream(adapter.stream(OPTIONS))

    expect(chunks).toEqual([])
    expect(error).toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect((error as Error).message).toContain('no account serves model "m"')
    expect(calls).toEqual([])
  })

  it('throws an aborted failure immediately', async () => {
    const pool = twoAccountPool()
    const { adapter, calls } = scriptedAdapter([new LlmError('stopped', 'ABORTED')], pool)

    const { error } = await collectStream(adapter.stream(OPTIONS))
    expect(error).toMatchObject({ code: 'ABORTED' })
    expect(calls).toEqual(['stable'])
  })

  it('tries at most three accounts and rethrows the last code unchanged', async () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [member('a'), member('b'), member('c'), member('d')],
      coverage: new Map([['m', ['a', 'b', 'c', 'd']]]),
    })
    const { adapter, calls } = scriptedAdapter(
      [
        new LlmError('down', 'SERVER'),
        new LlmError('down', 'SERVER'),
        new LlmError('down', 'SERVER'),
      ],
      pool,
    )

    const { error } = await collectStream(adapter.stream(OPTIONS))
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(error).toMatchObject({ code: 'SERVER' })
  })

  it('stops on the last pool member and keeps its failure code', async () => {
    const pool = new AccountPool({
      route: 'mdkj',
      accounts: [member('stable')],
      coverage: new Map([['m', ['stable']]]),
    })
    const { adapter, calls } = scriptedAdapter([new LlmError('bad key', 'AUTH')], pool)

    const { error } = await collectStream(adapter.stream(OPTIONS))
    expect(calls).toEqual(['stable'])
    expect(error).toMatchObject({ code: 'AUTH' })
  })
})

describe('FailoverPiAiAdapter: end to end over a stubbed transport', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const SSE = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}',
    '',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  async function pooledHarness(): Promise<{
    authorizations: string[]
    harness: Harness
  }> {
    vi.stubEnv('MORE_PROVIDERS_FAILOVER_A', 'key-a')
    vi.stubEnv('MORE_PROVIDERS_FAILOVER_B', 'key-b')
    const authorizations: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      authorizations.push(authorization)
      if (authorization.endsWith('key-a')) {
        return new Response(JSON.stringify({ error: { message: 'bad key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(SSE, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const harness = await createHarness({
      yaml: [
        'providers:',
        '  mdkj:',
        '    kind: custom',
        '    api: openai-completions',
        '    baseURL: https://failover.invalid/v1',
        '    models:',
        '      - id: m',
        '    accounts:',
        '      stable: { apiKeyEnv: MORE_PROVIDERS_FAILOVER_A }',
        '      cheap: { apiKeyEnv: MORE_PROVIDERS_FAILOVER_B }',
        '  chatgpt: { kind: chatgpt, enabled: false }',
      ].join('\n'),
    })
    return { authorizations, harness }
  }

  it('calls upstream once per account and forwards only the surviving attempt', async () => {
    const { authorizations, harness } = await pooledHarness()
    const { chunks, error } = await collectStream(
      registeredAdapter(harness.llm, 'mdkj').stream(request()),
    )

    expect(error).toBeUndefined()
    expect(authorizations).toStrictEqual(['Bearer key-a', 'Bearer key-b'])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toStrictEqual([
      textChunk('hello'),
    ])
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toHaveLength(1)
    const finishes = chunks.filter((chunk) => chunk.type === 'finish')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('publishes the cooling account through the providerKeys snapshot', async () => {
    const { harness } = await pooledHarness()
    await collectStream(registeredAdapter(harness.llm, 'mdkj').stream(request()))

    const keys = harness.ctx.get('providerKeys') as {
      accounts(route: string): readonly {
        id: string
        keyPresent: boolean
        healthy?: boolean
        cooldownUntil?: number
      }[]
    }
    const accounts = keys.accounts('mdkj')

    expect(accounts[0]).toMatchObject({ id: 'stable', keyPresent: true, healthy: false })
    expect(accounts[0]?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(accounts[1]).toMatchObject({ id: 'cheap', keyPresent: true, healthy: true })
  })

  it('fails over on the prepare-then-stream path the host actually dispatches', async () => {
    const { authorizations, harness } = await pooledHarness()
    const prepared = await (
      registeredAdapter(harness.llm, 'mdkj') as unknown as {
        prepareCall(
          provider: string,
          model: string,
        ): Promise<{ stream(options: GenerateOptions): AsyncIterable<StreamChunk> }>
      }
    ).prepareCall('mdkj', 'm')
    const { chunks, error } = await collectStream(prepared.stream(request()))

    expect(error).toBeUndefined()
    expect(authorizations).toStrictEqual(['Bearer key-a', 'Bearer key-b'])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toStrictEqual([
      textChunk('hello'),
    ])
  })
})
