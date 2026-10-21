/**
 * Answerer integration tests over the real `CmdPermit` service: the
 * `approval/request` listener it registers must decide a bash sub-call
 * dispatched through PTC (`tool/ptc-dispatch-start` as its only audit trail)
 * exactly like a directly dispatched one — allowlisted → allowed-once with a
 * notice; everything else (no mode, high-risk shape, wider mode, missing
 * evidence, uncovered sibling) → untouched `next()`.
 *
 * @module dsh-cmd-permit/approval.test
 */
import { describe, expect, it } from 'vitest'
import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { CmdPermit } from '../src/index.js'
import type { Config, MaxMode } from '../src/index.js'

const vol = <T>(value: T): Volatile<T> => ({ get: () => value as VolatileSnapshot<T> })

interface Fixture {
  events: { type: string; data: unknown }[]
  injected: { source?: { kind?: string; summary?: string } }[]
  service: CmdPermit
  answer(callId: string, toolName?: string): Promise<{ outcome: ApprovalOutcome; fellThrough: boolean }>
}

function makeFixture(overrides: Partial<Record<keyof Config, unknown>> = {}): Fixture {
  const listeners: { type: string; fn: (...args: unknown[]) => Promise<ApprovalOutcome>; prepend: boolean }[] = []
  const events: { type: string; data: unknown }[] = []
  const injected: unknown[] = []
  const session = {
    id: 'sess-1',
    snapshotEvents: () => [...events],
    append: () => {
      throw new Error('notices must go through agent.inject(), not a surface append')
    },
  }
  const agent = { id: 'agent-1', session, inject: (message: unknown) => injected.push(message) }
  const ctx = {
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    on: (type: string, fn: (...args: unknown[]) => Promise<ApprovalOutcome>, prepend = false) => {
      listeners.push({ type, fn, prepend })
      return () => {}
    },
  }
  const config = {
    enabled: vol(true),
    allow: vol(['rtk', 'cargo']),
    allowPattern: vol([]),
    denyShape: vol([]),
    maxMode: vol('danger-full-access' as MaxMode),
    ...overrides,
  }
  const service = new CmdPermit(ctx as never, config as never)
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
  return { events, injected: injected as Fixture['injected'], service, answer }
}

function ptcBash(fixture: Fixture, subCallId: string, args: Record<string, unknown>): void {
  fixture.events.push({
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: 'bash', arguments: args },
  })
}

describe('cmd-permit answerer over PTC evidence', () => {
  it('auto-allows an allowlisted PTC bash sub-call with a notice', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'rtk sync', sandbox_permissions: 'workspace-write' })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(outcome).toBe('allowed-once')
    expect(fellThrough).toBe(false)
    expect(fixture.injected).toHaveLength(1)
    expect(fixture.injected[0]?.source?.kind).toBe('cmd-permit')
    expect(fixture.injected[0]?.source?.summary).toContain('rtk')
  })

  it('still auto-allows a directly dispatched allowlisted call', async () => {
    const fixture = makeFixture()
    fixture.events.push({
      type: 'tool/call',
      data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'cargo build', sandbox_permissions: 'workspace-write' }) },
    })
    const { outcome, fellThrough } = await fixture.answer('c1')
    expect(outcome).toBe('allowed-once')
    expect(fellThrough).toBe(false)
  })

  it('does not let an allowlisted sibling cover its uncovered neighbor', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'npm install', sandbox_permissions: 'workspace-write' })
    ptcBash(fixture, 'root:ptc:2', { command: 'rtk sync', sandbox_permissions: 'workspace-write' })
    const uncovered = await fixture.answer('root:ptc:1')
    expect(uncovered.fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    const covered = await fixture.answer('root:ptc:2')
    expect(covered.outcome).toBe('allowed-once')
    expect(fixture.injected).toHaveLength(1)
  })

  it('defers a high-risk PTC sub-call even when its head is allowlisted', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'cargo build && sudo rm -rf /tmp/x', sandbox_permissions: 'danger-full-access' })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
  })

  it('defers a PTC sub-call that carries no escalation mode', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'rtk sync' })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
  })

  it('defers when the requested mode is wider than maxMode', async () => {
    const fixture = makeFixture({ maxMode: vol('workspace-write' as MaxMode) })
    ptcBash(fixture, 'root:ptc:1', { command: 'rtk sync', sandbox_permissions: 'danger-full-access' })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
  })

  it('falls back to the chain when no evidence exists for the call id', async () => {
    const fixture = makeFixture()
    const { fellThrough } = await fixture.answer('root:ptc:9')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
  })
})
