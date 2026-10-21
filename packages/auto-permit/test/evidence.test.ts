/**
 * Evidence-fold regression tests: one bash call must yield the same approval
 * evidence whether the host dispatched it directly (`tool/call`, JSON-string
 * arguments) or as a PTC sub-call (`tool/ptc-dispatch-start`, object
 * arguments, written BEFORE dispatch — so it is all that exists at approval
 * time).
 *
 * @module dsh-auto-permit/evidence.test
 */
import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { collectEvidence, MAX_COMMAND_CHARS } from '../src/evidence.js'

interface Fixture {
  type: string
  seq?: number
  data: unknown
}

/** Minimal session surface `collectEvidence` reads. */
function sessionOf(events: Fixture[]): Session {
  return { snapshotEvents: () => [...events] } as unknown as Session
}

/** Top-level `tool/call`: arguments are a JSON string. */
function directCall(seq: number, callId: string, name: string, args: unknown): Fixture {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } }
}

/** PTC sub-dispatch, exactly as dsh-tools appends it before scheduling. */
function ptcStart(
  seq: number,
  subCallId: string,
  args: unknown,
  extra: Record<string, unknown> = {},
): Fixture {
  return {
    type: 'tool/ptc-dispatch-start',
    seq,
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId,
      name: 'bash',
      arguments: args,
      ...extra,
    },
  }
}

function asked(seq: number, id: string, callId: string): Fixture {
  return { type: 'approval/asked', seq, data: { id, toolName: 'bash', callId } }
}

function decided(seq: number, id: string, outcome: string): Fixture {
  return { type: 'approval/decided', seq, data: { id, outcome } }
}

function userPrompt(seq: number, text: string): Fixture {
  return {
    type: 'user/message',
    seq,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

const UV_ARGS = {
  command: 'uv sync',
  description: 'Install project dependencies',
  sandbox_permissions: 'workspace-write',
  justification: 'uv needs its cache outside the workspace',
}

describe('pending-call recovery', () => {
  it('still recovers a direct top-level bash call with full arguments', () => {
    const evidence = collectEvidence(sessionOf([directCall(1, 'c1', 'bash', UV_ARGS)]), 'c1')
    expect(evidence.call).toEqual({
      command: 'uv sync',
      description: 'Install project dependencies',
      sandboxPermissions: 'workspace-write',
      justification: 'uv needs its cache outside the workspace',
    })
  })

  it('recovers a pending PTC bash sub-call from its start event alone (no completion yet)', () => {
    const evidence = collectEvidence(sessionOf([
      directCall(1, 'root', 'run_code', { code: 'bash("uv sync")' }),
      ptcStart(2, 'root:ptc:1', UV_ARGS),
    ]), 'root:ptc:1')
    expect(evidence.call).toEqual({
      command: 'uv sync',
      description: 'Install project dependencies',
      sandboxPermissions: 'workspace-write',
      justification: 'uv needs its cache outside the workspace',
    })
  })

  it('direct and PTC forms of the same command produce identical evidence', () => {
    const direct = collectEvidence(sessionOf([directCall(1, 'c1', 'bash', UV_ARGS)]), 'c1')
    const ptc = collectEvidence(sessionOf([ptcStart(1, 'root:ptc:1', UV_ARGS)]), 'root:ptc:1')
    expect(ptc.call).toEqual(direct.call)
  })

  it('leaves a call unrecoverable when its id appears twice with different content', () => {
    const evidence = collectEvidence(sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'uv sync' }),
      ptcStart(2, 'root:ptc:1', { command: 'rm -rf /' }),
    ]), 'root:ptc:1')
    expect(evidence.call).toBeUndefined()
  })

  it('leaves malformed PTC arguments unrecoverable, never guessed', () => {
    for (const bad of [
      {},
      { command: 42 },
      [],
      null,
      'uv sync',
      7,
    ]) {
      const evidence = collectEvidence(sessionOf([ptcStart(1, 'root:ptc:1', bad)]), 'root:ptc:1')
      expect(evidence.call).toBeUndefined()
    }
  })

  it('ignores PTC start events for other tools', () => {
    const evidence = collectEvidence(sessionOf([{
      type: 'tool/ptc-dispatch-start',
      seq: 1,
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'read', arguments: { file_path: 'a' } },
    }]), 'root:ptc:1')
    expect(evidence.call).toBeUndefined()
  })

  it('never recovers evidence from a bare tool/ptc-dispatch completion (old hosts)', () => {
    const evidence = collectEvidence(sessionOf([{
      type: 'tool/ptc-dispatch',
      seq: 1,
      data: { rootCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: UV_ARGS },
    }]), 'root:ptc:1')
    expect(evidence.call).toBeUndefined()
  })

  it('still rejects malformed direct JSON arguments', () => {
    const evidence = collectEvidence(sessionOf([{
      type: 'tool/call',
      seq: 1,
      data: { callId: 'c1', name: 'bash', arguments: '{"command": "x"' },
    }]), 'c1')
    expect(evidence.call).toBeUndefined()
  })
})

describe('sub-call isolation', () => {
  it('keeps sibling sub-calls under one root distinct', () => {
    const session = sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'cargo build', sandbox_permissions: 'workspace-write' }),
      ptcStart(2, 'root:ptc:2', { command: 'cargo test', sandbox_permissions: 'workspace-write' }),
    ])
    expect(collectEvidence(session, 'root:ptc:1').call?.command).toBe('cargo build')
    expect(collectEvidence(session, 'root:ptc:2').call?.command).toBe('cargo test')
  })

  it('keeps interleaved sub-calls from different roots distinct', () => {
    const session = sessionOf([
      ptcStart(1, 'a:ptc:1', { command: 'echo a1' }),
      ptcStart(2, 'b:ptc:1', { command: 'echo b1' }),
      ptcStart(3, 'a:ptc:2', { command: 'echo a2' }),
      ptcStart(4, 'b:ptc:2', { command: 'echo b2' }),
    ])
    expect(collectEvidence(session, 'a:ptc:2').call?.command).toBe('echo a2')
    expect(collectEvidence(session, 'b:ptc:1').call?.command).toBe('echo b1')
  })

  it('resolves nested PTC sub-call ids (run_code inside run_code)', () => {
    const session = sessionOf([
      {
        type: 'tool/ptc-dispatch-start',
        seq: 1,
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'run_code', arguments: { code: '…' } },
      },
      ptcStart(2, 'root:ptc:1:ptc:1', UV_ARGS, { rootCallId: 'root', parentCallId: 'root:ptc:1' }),
    ])
    expect(collectEvidence(session, 'root:ptc:1:ptc:1').call?.command).toBe('uv sync')
  })
})

describe('approval history across both paths', () => {
  it('counts a prior PTC approval in the approved history for a pending direct call', () => {
    const evidence = collectEvidence(sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      asked(2, 'a1', 'root:ptc:1'),
      decided(3, 'a1', 'allowed-once'),
      directCall(4, 'd1', 'bash', { command: 'uv lock', sandbox_permissions: 'workspace-write' }),
    ]), 'd1')
    expect(evidence.approved).toEqual(['uv sync'])
  })

  it('counts a prior direct approval in the approved history for a pending PTC call', () => {
    const evidence = collectEvidence(sessionOf([
      directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      asked(2, 'a1', 'd1'),
      decided(3, 'a1', 'allowed-once'),
      ptcStart(4, 'root:ptc:1', { command: 'uv lock', sandbox_permissions: 'workspace-write' }),
    ]), 'root:ptc:1')
    expect(evidence.approved).toEqual(['uv sync'])
  })

  it('approving one sibling does not make the other an exact repeat', () => {
    const evidence = collectEvidence(sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      ptcStart(2, 'root:ptc:2', { command: 'cargo build', sandbox_permissions: 'workspace-write' }),
      asked(3, 'a1', 'root:ptc:1'),
      decided(4, 'a1', 'allowed-once'),
    ]), 'root:ptc:2')
    // The approved list is session-wide memory (the judge may see it), but a
    // DIFFERENT command must never become an exact repeat of its sibling.
    expect(evidence.approved).toEqual(['uv sync'])
    expect(evidence.exactRepeat).toBe(false)
  })
})

describe('exact-repeat memory across both paths', () => {
  it('approved PTC sub-call makes a direct repeat exact', () => {
    const evidence = collectEvidence(sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      asked(2, 'a1', 'root:ptc:1'),
      decided(3, 'a1', 'allowed-once'),
      directCall(4, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
    ]), 'd1')
    expect(evidence.exactRepeat).toBe(true)
  })

  it('approved direct call makes a PTC repeat exact', () => {
    const evidence = collectEvidence(sessionOf([
      directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      asked(2, 'a1', 'd1'),
      decided(3, 'a1', 'allowed-once'),
      ptcStart(4, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
    ]), 'root:ptc:1')
    expect(evidence.exactRepeat).toBe(true)
  })

  it('a different escalation mode is not an exact repeat', () => {
    const evidence = collectEvidence(sessionOf([
      directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      asked(2, 'a1', 'd1'),
      decided(3, 'a1', 'allowed-once'),
      ptcStart(4, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'danger-full-access' }),
    ]), 'root:ptc:1')
    expect(evidence.exactRepeat).toBe(false)
  })

  it('rejected, cancelled, and undecided approvals never form memory', () => {
    for (const outcome of ['rejected', 'cancelled', undefined]) {
      const events: Fixture[] = [
        directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'd1'),
      ]
      if (outcome !== undefined) events.push(decided(3, 'a1', outcome))
      events.push(ptcStart(4, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }))
      const evidence = collectEvidence(sessionOf(events), 'root:ptc:1')
      expect(evidence.approved).toEqual([])
      expect(evidence.exactRepeat).toBe(false)
    }
  })

  it('the pending ask itself is excluded from the repeat check', () => {
    const evidence = collectEvidence(sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      asked(2, 'a1', 'root:ptc:1'),
    ]), 'root:ptc:1')
    // No decision yet: neither approved history nor exact repeat.
    expect(evidence.approved).toEqual([])
    expect(evidence.exactRepeat).toBe(false)
  })
})

describe('unchanged policy around the fold', () => {
  it('gathers prompts only from human user messages', () => {
    const evidence = collectEvidence(sessionOf([
      userPrompt(1, 'please run the suite'),
      {
        type: 'user/message',
        seq: 2,
        data: { source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool output' }] },
      },
      ptcStart(3, 'root:ptc:1', UV_ARGS),
    ]), 'root:ptc:1')
    expect(evidence.prompts).toEqual(['please run the suite'])
  })

  it('ignores unknown event types', () => {
    const evidence = collectEvidence(sessionOf([
      { type: 'mystery/event', seq: 1, data: { subCallId: 'root:ptc:1', name: 'bash', arguments: UV_ARGS } },
      ptcStart(2, 'root:ptc:1', UV_ARGS),
    ]), 'root:ptc:1')
    expect(evidence.call?.command).toBe('uv sync')
  })

  it('still clips over-long commands', () => {
    const long = 'uv sync ' + 'x'.repeat(MAX_COMMAND_CHARS)
    const evidence = collectEvidence(sessionOf([ptcStart(1, 'root:ptc:1', { command: long })]), 'root:ptc:1')
    expect(evidence.call?.command.length).toBeLessThanOrEqual(MAX_COMMAND_CHARS + '…[truncated]'.length)
    expect(evidence.call?.command.endsWith('…[truncated]')).toBe(true)
  })
})
