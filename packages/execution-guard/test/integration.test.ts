import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/index.js'

const readParameters = {
  type: 'object',
  properties: { file_path: { type: 'string' }, offset: { type: 'integer' } },
  required: ['file_path'],
}
const writeParameters = {
  type: 'object',
  properties: { file_path: { type: 'string' }, content: { type: 'string' } },
  required: ['file_path', 'content'],
}

interface Fixture {
  ctx: Context
  listeners: Map<string, { fn: (...args: unknown[]) => unknown; prepend: boolean }[]>
  registered: ToolDefinition[]
  session: {
    id: string
    header: { cwd?: string }
    events: unknown[]
    appended: { type: string; data: unknown; opts: unknown }[]
    snapshotEvents(): unknown[]
    append(type: string, data: unknown, opts: unknown): unknown
  }
  agent: { id: string; session: unknown; inject(message: unknown): void }
  tempDir: string
  events: unknown[]
  appended: { type: string; data: unknown; opts: unknown }[]
  injected: unknown[]
}

function makeFixture(overrides: Partial<Config> = {}): Fixture {
  const fixture = {} as Fixture
  fixture.listeners = new Map()
  fixture.registered = []
  fixture.events = []
  fixture.appended = []
  fixture.injected = []
  fixture.session = {
    id: 'sess-it',
    header: { cwd: undefined },
    events: fixture.events,
    appended: fixture.appended,
    snapshotEvents: () => [...fixture.events],
    append: (type, data, opts) => {
      fixture.appended.push({ type, data, opts })
      return undefined
    },
  }
  fixture.agent = {
    id: 'agent-it',
    session: fixture.session,
    // The host's deferred next-step channel: what a real ReactLoopAgent exposes.
    inject: (message: unknown) => {
      fixture.injected.push(message)
    },
  }
  const fakeCtx = {
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
    on: (type: string, fn: (...args: unknown[]) => unknown, prepend = false) => {
      const list = fixture.listeners.get(type) ?? []
      list.push({ fn, prepend })
      fixture.listeners.set(type, list)
      return () => {}
    },
    tools: {
      schemas: () => [
        { name: 'read', description: '', parameters: readParameters },
        { name: 'write', description: '', parameters: writeParameters },
      ],
      register: (def: ToolDefinition) => {
        fixture.registered.push(def)
        return () => {}
      },
    },
  }
  fixture.ctx = fakeCtx as unknown as Context
  void fixture.ctx
  void overrides
  return fixture
}

async function initFixture(fixture: Fixture, overrides: Partial<Config> = {}): Promise<void> {
  fixture.tempDir = await mkdtemp(join(tmpdir(), 'guard-it-'))
  fixture.session.header.cwd = fixture.tempDir
  apply(fixture.ctx as Context, { preflight: true, repeatHints: true, ...overrides })
}

const tempRoots: string[] = []
afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('adapter: mixed native batch (host appends tool/call one at a time)', () => {
  let fixture: Fixture
  let nextCalls: number

  beforeAll(async () => {
    fixture = makeFixture()
    await initFixture(fixture)
    nextCalls = 0
    const next = { count: nextCalls }
    void next
    fixture.events.push(
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 0, data: { source: { kind: 'user' }, content: [] } },
      { type: 'step/start', seq: 3, time: 0, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 4,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' },
              { type: 'tool-call', id: 'c2', name: 'write', arguments: '{"file_path":"b.txt"}' },
              { type: 'tool-call', id: 'c3', name: 'write', arguments: '{"file_path":3,"content":"x"}' },
            ],
          },
          stream: [],
        },
      },
      { type: 'tool/call', seq: 5, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
    )
  })

  it('the FIRST execution (only its own tool/call appended) denies on the invalid batch-mates', async () => {
    const run = wrapPre(fixture, () => {
      nextCalls += 1
    })
    const decision = await run({ callId: 'c1', name: 'read', arguments: { file_path: 'a.txt' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(decision).toMatchObject({ kind: 'deny', info: { code: 'INVALID_ARGS' } })
    expect(nextCalls).toBe(0)
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('write')
    expect(reason).toContain('c2')
    expect(reason).toContain('c3')
    expect(reason).toContain('content')
  })

  it('the invalid siblings deny too — the whole step output is rejected', async () => {
    const run = wrapPre(fixture, () => {
      nextCalls += 1
    })
    for (const [callId, args] of [
      ['c2', { file_path: 'b.txt' }],
      ['c3', { file_path: 3, content: 'x' }],
    ] as const) {
      const decision = await run({ callId, name: 'write', arguments: args, agent: fixture.agent, signal: new AbortController().signal })
      expect(decision).toMatchObject({ kind: 'deny' })
    }
    expect(nextCalls).toBe(0)
  })
})

function wrapPre(fixture: Fixture, onNext: () => void): (exec: Record<string, unknown>) => Promise<unknown> {
  const list = fixture.listeners.get('tools/pre-execute') ?? []
  const entry = list.find((item) => item.prepend) ?? list[0]
  if (entry === undefined) throw new Error('no pre-execute listener registered')
  return async (exec) => entry.fn(exec, async () => {
    onNext()
    return { kind: 'allow' }
  })
}

describe('adapter: legal batch and degenerate cases', () => {
  it('a fully legal batch passes through to the host chain', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    fixture.events.push(
      { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 2,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a"}' },
              { type: 'tool-call', id: 'c2', name: 'write', arguments: '{"file_path":"b","content":"x"}' },
            ],
          },
          stream: [],
        },
      },
    )
    let passed = 0
    const run = wrapPre(fixture, () => {
      passed += 1
    })
    const decision = await run({ callId: 'c1', name: 'read', arguments: { file_path: 'a' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(decision).toEqual({ kind: 'allow' })
    expect(passed).toBe(1)
  })

  it('without an assistant batch message, the current call alone is checked (and may deny)', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    fixture.events.push({ type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } })
    let passed = 0
    const run = wrapPre(fixture, () => {
      passed += 1
    })
    const decision = await run({ callId: 'c1', name: 'write', arguments: { file_path: 'b' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(passed).toBe(0)
  })

  it('a PTC sub-dispatch validates only the current call against its binding schema', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    const token = Symbol('parent')
    let passed = 0
    const run = wrapPre(fixture, () => {
      passed += 1
    })
    const bad = await run({
      callId: 'p1',
      name: 'read',
      arguments: {},
      agent: fixture.agent,
      signal: new AbortController().signal,
      parent: token,
      schema: { name: 'read', description: '', parameters: readParameters },
    })
    expect(bad).toMatchObject({ kind: 'deny' })
    expect(passed).toBe(0)
    const good = await run({
      callId: 'p2',
      name: 'read',
      arguments: { file_path: 'x' },
      agent: fixture.agent,
      signal: new AbortController().signal,
      parent: token,
      schema: { name: 'read', description: '', parameters: readParameters },
    })
    expect(good).toEqual({ kind: 'allow' })
    expect(passed).toBe(1)
  })

  it('a PTC sub-call without a binding schema defers to the host', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    let passed = 0
    const run = wrapPre(fixture, () => {
      passed += 1
    })
    const decision = await run({
      callId: 'p1',
      name: 'read',
      arguments: { nonsense: true },
      agent: fixture.agent,
      signal: new AbortController().signal,
      parent: Symbol('p'),
    })
    expect(decision).toEqual({ kind: 'allow' })
    expect(passed).toBe(1)
  })
})

describe('adapter: repeat hints via the tools/result final-outcome observer', () => {
  const errorResult = {
    isError: true as const,
    error: { message: 'x', info: { name: 'execution-guard', code: 'INVALID_ARGS' } },
    content: [],
  }

  function pushStep(fixture: Fixture, callId: string, args: string, step: number, seq: number): void {
    fixture.events.push(
      { type: 'step/start', seq, time: 0, data: { turn: step, step: 1 } },
      {
        type: 'assistant/message',
        seq: seq + 1,
        time: 0,
        data: {
          turn: step,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'write', arguments: args }] },
          stream: [],
        },
      },
    )
  }

  function resultListener(fixture: Fixture): (exec: Record<string, unknown>, result: unknown) => void {
    const list = fixture.listeners.get('tools/result') ?? []
    const entry = list[0]
    if (entry === undefined) throw new Error('no tools/result listener registered')
    return (exec, result) => {
      entry.fn(exec, result)
    }
  }

  /** Notices delivered the order-safe way: through `agent.inject()`. */
  function hints(fixture: Fixture): { kind?: string; form?: string }[] {
    return fixture.injected
      .map((message) => (message as { source?: { kind?: string; form?: string } }).source ?? {})
  }

  /** Notices written straight onto the session surface (must stay empty). */
  function surfaceNotices(fixture: Fixture): { kind?: string }[] {
    return fixture.appended
      .filter((entry) => entry.type === 'user/message')
      .map((entry) => (entry.data as { source?: { kind?: string } }).source ?? {})
  }

  it('first final invalid counts, second final invalid appends the hint notice; valid siblings never count', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    pushStep(fixture, 'c2', '{"file_path":"b"}', 1, 1)
    fixture.events.push(
      { type: 'step/start', seq: 3, time: 0, data: { turn: 2, step: 1 } },
      {
        type: 'assistant/message',
        seq: 4,
        time: 0,
        data: {
          turn: 2,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a"}' },
              { type: 'tool-call', id: 'c2', name: 'write', arguments: '{"file_path":"z"}' },
            ],
          },
          stream: [],
        },
      },
    )
    const pre = wrapPre(fixture, () => ({ kind: 'allow' }))
    const onResult = resultListener(fixture)

    // First occurrence: deny + final invalid -> count 1, NO hint yet.
    const first = await pre({ callId: 'c2', name: 'write', arguments: { file_path: 'b' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(first).toMatchObject({ kind: 'deny' })
    onResult({ callId: 'c2', name: 'write', arguments: {}, agent: fixture.agent }, errorResult)
    expect(hints(fixture)).toEqual([])

    // Second same-shape occurrence in a later step: count 2 -> hint notice
    // appended to the session with the standard execution-guard source.
    const second = await pre({ callId: 'c2', name: 'write', arguments: { file_path: 'z' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(second).toMatchObject({ kind: 'deny' })
    onResult({ callId: 'c2', name: 'write', arguments: {}, agent: fixture.agent }, errorResult)
    expect(hints(fixture).some((source) => source.kind === 'execution-guard' && source.form === 'hint')).toBe(true)
    // ...and never as a bare surface append: the observer fires per call
    // inside the batch, where a surface user/message would split a parallel
    // batch's tool-call/result pairing (HTTP 400 on OpenAI-compatible endpoints).
    expect(surfaceNotices(fixture)).toEqual([])

    // Valid sibling denied by the batch-mate: final INVALID_ARGS but no
    // own-argument fault — counted never, hinted never.
    const valid = await pre({ callId: 'c1', name: 'read', arguments: { file_path: 'a' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(valid).toMatchObject({ kind: 'deny' })
    const before = hints(fixture).length
    onResult({ callId: 'c1', name: 'read', arguments: {}, agent: fixture.agent }, errorResult)
    expect(hints(fixture)).toHaveLength(before)
  })

  it('a cancelled success settles as an error and does NOT reset the tracker', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    pushStep(fixture, 'c2', '{"file_path":"b"}', 1, 1)
    const pre = wrapPre(fixture, () => ({ kind: 'allow' }))
    const onResult = resultListener(fixture)
    const aborted = {
      isError: true as const,
      error: { message: 'cancelled', info: { name: 'bash', code: 'ABORTED' } },
      content: [],
    }

    await pre({ callId: 'c2', name: 'write', arguments: { file_path: 'b' }, agent: fixture.agent, signal: new AbortController().signal })
    onResult({ callId: 'c2', name: 'write', arguments: {}, agent: fixture.agent }, errorResult)
    // A successful write settles as ABORTED after cancellation: no reset.
    onResult({ callId: 'ok1', name: 'write', arguments: {}, agent: fixture.agent }, aborted)
    // Therefore the next same-shape invalid is the SECOND -> hint.
    pushStep(fixture, 'c3', '{"file_path":"q"}', 2, 5)
    await pre({ callId: 'c3', name: 'write', arguments: { file_path: 'q' }, agent: fixture.agent, signal: new AbortController().signal })
    onResult({ callId: 'c3', name: 'write', arguments: {}, agent: fixture.agent }, errorResult)
    expect(hints(fixture).some((source) => source.kind === 'execution-guard' && source.form === 'hint')).toBe(true)
  })

  it('host-final INVALID_ARGS outcomes (no preflight deny) count via message-line fingerprints', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    const onResult = resultListener(fixture)
    const hostInvalid = {
      isError: true as const,
      error: { message: 'arguments.file_path: expected string, got number', info: { name: 'registry', code: 'INVALID_ARGS' } },
      content: [],
    }
    onResult({ callId: 'h1', name: 'write', arguments: {}, agent: fixture.agent }, hostInvalid)
    expect(hints(fixture)).toEqual([])
    onResult({ callId: 'h2', name: 'write', arguments: {}, agent: fixture.agent }, hostInvalid)
    expect(hints(fixture).some((source) => source.kind === 'execution-guard' && source.form === 'hint')).toBe(true)
  })
})
