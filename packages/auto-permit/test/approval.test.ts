/**
 * Approval-listener integration tests: drive the REAL `approval/request`
 * listener `apply()` registers (fake host surface, fake judge route) and
 * assert the full decision order — high-risk → allowlist → memory → judge —
 * works for a bash sub-call dispatched through PTC, whose only audit trail
 * at approval time is `tool/ptc-dispatch-start`.
 *
 * @module dsh-auto-permit/approval.test
 */
import { describe, expect, it } from 'vitest'
import type { Context, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'

const vol = <T>(value: T): Volatile<T> => ({ get: () => value as VolatileSnapshot<T> })

interface Fixture {
  events: { type: string; data: unknown }[]
  injected: { source?: { kind?: string; summary?: string } }[]
  appended: unknown[]
  llmCalls: { messages: { content: { type: string; text?: string }[] }[] }[]
  answer(callId: string, toolName?: string): Promise<{ outcome: ApprovalOutcome; fellThrough: boolean }>
}

function makeFixture(cmdPermit?: unknown): Fixture {
  const listeners: { type: string; fn: (...args: unknown[]) => Promise<ApprovalOutcome>; prepend: boolean }[] = []
  const events: { type: string; data: unknown }[] = []
  const injected: unknown[] = []
  const appended: unknown[] = []
  const llmCalls: unknown[] = []
  const session = {
    id: 'sess-1',
    snapshotEvents: () => [...events],
    append: (type: string, data: unknown, opts: unknown) => {
      appended.push({ type, data, opts })
    },
  }
  const agent = { id: 'agent-1', session, inject: (message: unknown) => injected.push(message) }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name: string) => (name === 'cmdPermit' ? cmdPermit : undefined),
    on: (type: string, fn: (...args: unknown[]) => Promise<ApprovalOutcome>, prepend = false) => {
      listeners.push({ type, fn, prepend })
      return () => {}
    },
    llm: {
      stream: (request: unknown) => {
        llmCalls.push(request)
        return (async function* () {})()
      },
    },
  }
  apply(ctx as unknown as Context, {
    enabled: vol(true),
    provider: vol('test-provider'),
    model: vol('test-model'),
  } as Config)
  const answer = (callId: string, toolName = 'bash') => {
    const entry = listeners.find((item) => item.type === 'approval/request')
    if (entry === undefined) throw new Error('no approval/request listener registered')
    let fellThrough = false
    const outcome = entry.fn(
      { agent, toolName, callId, signal: undefined },
      async () => {
        fellThrough = true
        return 'rejected' as const
      },
    )
    return outcome.then((value) => ({ outcome: value, fellThrough }))
  }
  return {
    events,
    injected: injected as Fixture['injected'],
    appended,
    llmCalls: llmCalls as Fixture['llmCalls'],
    answer,
  }
}

/** A PTC sub bash call exactly as the host logs it before scheduling. */
function ptcBash(fixture: Fixture, subCallId: string, args: Record<string, unknown>): void {
  fixture.events.push({
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: 'bash', arguments: args },
  })
}

/** A prior settled direct approval (asked + allowed-once pair). */
function priorDirectAllowed(fixture: Fixture, callId: string, args: Record<string, unknown>, id: string): void {
  fixture.events.push(
    { type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify(args) } },
    { type: 'approval/asked', data: { id, toolName: 'bash', callId } },
    { type: 'approval/decided', data: { id, outcome: 'allowed-once' } },
  )
}

describe('auto-permit answerer over PTC evidence', () => {
  it('claims an allowlisted PTC sub-call before the judge, with a notice and no model call', async () => {
    const fixture = makeFixture({ isHighRisk: () => false, claim: () => ({ via: 'rtk' }) })
    ptcBash(fixture, 'root:ptc:1', { command: 'rtk sync', sandbox_permissions: 'workspace-write' })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(outcome).toBe('allowed-once')
    expect(fellThrough).toBe(false)
    expect(fixture.llmCalls).toHaveLength(0)
    expect(fixture.injected).toHaveLength(1)
    expect(fixture.injected[0]?.source?.summary).toContain('cmd-permit')
    // The order-safe channel: never a bare surface append mid-batch.
    expect(fixture.appended).toEqual([])
  })

  it('defers a high-risk PTC sub-call to the human with a high-risk notice', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'sudo rm -rf /tmp/x', sandbox_permissions: 'danger-full-access' })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected') // the next() sentinel, i.e. the human dialog
    expect(fixture.llmCalls).toHaveLength(0)
    expect(fixture.injected.some((message) => message.source?.summary?.includes('irreversible'))).toBe(true)
  })

  it('allows a PTC exact repeat of a directly-approved command without a model call', async () => {
    const fixture = makeFixture()
    priorDirectAllowed(fixture, 'd1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }, 'a1')
    ptcBash(fixture, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(outcome).toBe('allowed-once')
    expect(fellThrough).toBe(false)
    expect(fixture.llmCalls).toHaveLength(0)
    expect(fixture.injected.some((message) => message.source?.summary?.includes('seen this session'))).toBe(true)
  })

  it('hands the judge the full PTC evidence and defers when it defers', async () => {
    const fixture = makeFixture()
    fixture.events.push({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'please run the suite' }] },
    })
    ptcBash(fixture, 'root:ptc:1', {
      command: 'uv sync',
      description: 'Install project dependencies',
      sandbox_permissions: 'workspace-write',
      justification: 'uv needs its cache outside the workspace',
    })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    // The fake judge model yields nothing → defer → next().
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected')
    expect(fixture.llmCalls).toHaveLength(1)
    const text = fixture.llmCalls[0]?.messages[0]?.content
      ?.map((block) => block.text ?? '')
      .join('\n') ?? ''
    expect(text).toContain('"uv sync"')
    expect(text).toContain('"workspace-write"')
    expect(text).toContain('Install project dependencies')
    expect(text).toContain('uv needs its cache outside the workspace')
    expect(text).toContain('please run the suite')
  })

  it('falls back to the chain untouched on hosts without a start event (old hosts)', async () => {
    const fixture = makeFixture()
    fixture.events.push({
      type: 'tool/ptc-dispatch',
      data: {
        rootCallId: 'root',
        subCallId: 'root:ptc:1',
        name: 'bash',
        arguments: { command: 'rtk sync', sandbox_permissions: 'workspace-write' },
      },
    })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    expect(fixture.llmCalls).toHaveLength(0)
  })

  it('falls back without a notice on malformed PTC evidence', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { description: 'no command here' })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    expect(fixture.llmCalls).toHaveLength(0)
  })

  it('leaves non-bash approval requests to the chain', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'uv sync' })
    const { fellThrough } = await fixture.answer('root:ptc:1', 'read')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    expect(fixture.llmCalls).toHaveLength(0)
  })
})
