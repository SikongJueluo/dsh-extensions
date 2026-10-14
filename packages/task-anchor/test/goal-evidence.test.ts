import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeGoalChangeV1, foldGoalEvents, mergeGoal } from '../src/goal-evidence.js'

let seq = 0
function ev(type: string, data: Record<string, unknown>): SessionEvent {
  seq += 1
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** Real `GoalSnapshotChangeMeta` v1 shape from dsh-goal domain.d.ts. */
function goalChange(overrides: Record<string, unknown> = {}): SessionEvent {
  return ev('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation: 'update',
    goal: { id: 'g1', revision: 3, objective: 'ship it', phase: 'active', maxGoalRounds: 10 },
    roundsStarted: 2,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  })
}

/** Real `GoalClearChangeMeta` v1 tombstone shape. */
function goalClear(goalId = 'g1', revision = 3): SessionEvent {
  return ev('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation: 'clear',
    cleared: { id: goalId, revision },
    clearedAt: 300,
  })
}

function toolCall(name: string, args: Record<string, unknown>, callId = `c${seq + 1}`): SessionEvent {
  seq += 1
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  } as unknown as SessionEvent
}

function toolResult(callId: string, isError: boolean): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: callId, isError, content: [] },
  })
}

describe('decodeGoalChangeV1', () => {
  it('decodes a real v1 snapshot change', () => {
    expect(decodeGoalChangeV1({
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: { id: 'g', revision: 1, objective: 'o', phase: 'active', maxGoalRounds: 5 },
    })).toEqual({ op: 'snapshot', snapshot: { goalId: 'g', revision: 1, phase: 'active' } })
  })

  it('returns undefined for non-goal values and unreadable for shape deviations', () => {
    expect(decodeGoalChangeV1({ type: 'other' })).toBeUndefined()
    expect(decodeGoalChangeV1(null)).toBeUndefined()
    expect(decodeGoalChangeV1({ kind: 'goal/change', version: 2 })).toBe('unreadable')
    expect(decodeGoalChangeV1({ kind: 'goal/change', version: 1, operation: 'edit', goal: { id: 'g' } })).toBe('unreadable')
    expect(decodeGoalChangeV1({ kind: 'goal/change', version: 1, operation: 'edit', goal: { id: 'g', revision: 1, phase: 'dormant' } })).toBe('unreadable')
    expect(decodeGoalChangeV1({ kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 3 } })).toBe('unreadable')
  })

  it('decodes the clear tombstone', () => {
    expect(decodeGoalChangeV1({ kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g', revision: 4 } })).toEqual({ op: 'clear' })
  })
})

describe('foldGoalEvents (durable v1 events only)', () => {
  it('folds the latest snapshot, keeping the durable phase', () => {
    const fold = foldGoalEvents([
      goalChange({ goal: { id: 'g1', revision: 1, objective: 'o', phase: 'active', maxGoalRounds: 10 }, operation: 'create' }),
      goalChange({ goal: { id: 'g1', revision: 3, objective: 'o', phase: 'blocked', maxGoalRounds: 10 }, operation: 'block' }),
    ])
    expect(fold).toEqual({ kind: 'snapshot', snapshot: { goalId: 'g1', revision: 3, phase: 'blocked' } })
  })

  it('ignores tool/call requests entirely — a FAILED update_goal changes nothing', () => {
    const fold = foldGoalEvents([
      goalChange({ goal: { id: 'g1', revision: 2, objective: 'o', phase: 'active', maxGoalRounds: 10 }, operation: 'update' }),
      toolCall('update_goal', { goal_id: 'g1', revision: 2, action: 'edit' }, 'req1'),
      toolResult('req1', true),
      toolCall('update_goal', { goal_id: 'g1', revision: 2, action: 'complete' }, 'req2'),
      toolResult('req2', false),
    ])
    expect(fold).toEqual({ kind: 'snapshot', snapshot: { goalId: 'g1', revision: 2, phase: 'active' } })
  })

  it('a clear tombstone resets to no goal even after a snapshot', () => {
    expect(foldGoalEvents([
      goalChange({ goal: { id: 'g1', revision: 5, objective: 'o', phase: 'active', maxGoalRounds: 10 }, operation: 'update' }),
      goalClear('g1', 5),
    ])).toEqual({ kind: 'cleared' })
  })

  it('recognizes every durable phase including blocked and complete', () => {
    for (const phase of ['active', 'paused', 'blocked', 'complete'] as const) {
      expect(foldGoalEvents([goalChange({ goal: { id: 'g', revision: 1, objective: 'o', phase, maxGoalRounds: 1 }, operation: 'edit' })])).toEqual({
        kind: 'snapshot',
        snapshot: { goalId: 'g', revision: 1, phase },
      })
    }
  })

  it('no goal events at all folds to none', () => {
    expect(foldGoalEvents([toolCall('create_goal', { objective: 'x' })])).toEqual({ kind: 'none' })
    expect(foldGoalEvents([])).toEqual({ kind: 'none' })
  })

  it('unknown versions and malformed payloads fold to unreadable, never a guess', () => {
    expect(foldGoalEvents([ev('goal/change', { kind: 'goal/change', version: 99 })])).toEqual({ kind: 'unreadable' })
    expect(foldGoalEvents([ev('goal/change', { kind: 'goal/change', version: 1, operation: 'update' })])).toEqual({ kind: 'unreadable' })
  })

  it('a later valid event recovers the fold after an unreadable one', () => {
    const fold = foldGoalEvents([
      ev('goal/change', { kind: 'goal/change', version: 99 }),
      goalChange({ goal: { id: 'g2', revision: 1, objective: 'o', phase: 'active', maxGoalRounds: 3 }, operation: 'create' }),
    ])
    expect(fold).toEqual({ kind: 'snapshot', snapshot: { goalId: 'g2', revision: 1, phase: 'active' } })
  })
})

describe('mergeGoal (CAS against the durable fold only)', () => {
  const snap = { goalId: 'g', revision: 3, phase: 'active' } as const

  it('proves the claim when id and revision both agree, carrying the phase', () => {
    expect(mergeGoal({ goalId: 'g', goalRevision: 3 }, { kind: 'snapshot', snapshot: snap })).toEqual({
      goal: { goalId: 'g', revision: 3, phase: 'active' },
      proof: 'fold-agrees',
    })
  })

  it('conflicts on revision drift (update happened)', () => {
    expect(mergeGoal({ goalId: 'g', goalRevision: 2 }, { kind: 'snapshot', snapshot: snap })).toMatchObject({
      conflict: expect.stringContaining('goal revision mismatch'),
    })
  })

  it('conflicts when a NEW goal reuses the same revision number', () => {
    expect(mergeGoal({ goalId: 'old', goalRevision: 3 }, { kind: 'snapshot', snapshot: snap })).toMatchObject({
      conflict: expect.stringContaining('goal id mismatch'),
    })
  })

  it('records an unverified assertion only when durable proof is absent or unreadable', () => {
    for (const fold of [{ kind: 'none' } as const, { kind: 'unreadable' } as const]) {
      expect(mergeGoal({ goalId: 'g', goalRevision: 2 }, fold)).toEqual({
        goal: { goalId: 'g', revision: 2 },
        proof: 'args-only-unverified',
      })
    }
  })

  it('a cleared fold is counter-evidence: an asserted goal conflicts, not unverified', () => {
    expect(mergeGoal({ goalId: 'g', goalRevision: 2 }, { kind: 'cleared' })).toMatchObject({
      conflict: expect.stringContaining('cleared'),
    })
  })

  it('yields nothing without an asserted identity', () => {
    expect(mergeGoal({}, { kind: 'snapshot', snapshot: snap })).toEqual({})
    expect(mergeGoal({}, { kind: 'none' })).toEqual({})
  })
})
