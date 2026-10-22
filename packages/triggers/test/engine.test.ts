/**
 * Engine tests: the full loop plus every stop/abuse path, all through the
 * pure seam — no Cordis, no storage, no clocks.
 *
 * @module dsh-triggers/engine.test
 */
import { describe, expect, it } from 'vitest'
import {
  autoDeliver,
  cancelRun,
  commitTurnEnd,
  dueNudge,
  extendBudget,
  pauseRun,
  renderTemplate,
  resumeRun,
  roleOf,
  signalBelongsTo,
  startRun,
  submitSignal,
} from '../src/engine.js'
import type { BindingRecord, RunRecord, RunTemplateBodies } from '../src/model.js'

const EXECUTOR = 'session-executor'
const PARENT = 'session-parent'
const OUTSIDER = 'session-outsider'
const BODIES: RunTemplateBodies = { start: 's', review: 'r', rework: 'w' }

function binding(maxRounds = 5): BindingRecord {
  return {
    id: 'binding-1',
    name: 'loop',
    executor: EXECUTOR,
    parent: PARENT,
    maxRounds,
    enabled: true,
    templates: { start: 't-start', review: 't-review', rework: 't-rework' },
    createdAt: 1,
    updatedAt: 1,
  }
}

function freshRun(maxRounds = 5): RunRecord {
  return startRun(binding(maxRounds), BODIES, '任务', 'run-1', 1000)
}

/** Deliver round `n` (signal + its completed turn end), returning the run. */
function deliver(run: RunRecord, turn: number, now: number): { run: RunRecord } {
  const accepted = submitSignal(run, EXECUTOR, 'deliver', `第 ${run.round} 轮交付`, turn, now)
  if (!accepted.ok) throw new Error(`deliver rejected: ${accepted.code}`)
  const ended = commitTurnEnd(accepted.run, EXECUTOR, turn, 'completed', now)
  if (ended.kind !== 'advance') throw new Error(`deliver turn end: ${ended.kind}`)
  return { run: ended.run }
}

describe('happy loop', () => {
  it('starts in round 1 awaiting the executor', () => {
    const run = freshRun()
    expect(run.status).toBe('active')
    expect(run.phase).toBe('awaiting-delivery')
    expect(run.round).toBe(1)
    expect(roleOf(run, EXECUTOR)).toBe('executor')
    expect(roleOf(run, PARENT)).toBe('parent')
    expect(roleOf(run, OUTSIDER)).toBeUndefined()
  })

  it('deliver → review intent to the parent, same round', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done: x', 3, 1100)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.run.pendingSignal?.turn).toBe(3)
    expect(accepted.run.pendingSignal?.session).toBe(EXECUTOR)
    const ended = commitTurnEnd(accepted.run, EXECUTOR, 3, 'completed', 1200)
    expect(ended.kind).toBe('advance')
    if (ended.kind !== 'advance') return
    expect(ended.run.phase).toBe('awaiting-review')
    expect(ended.run.round).toBe(1)
    expect(ended.intents).toEqual([{ runId: 'run-1', round: 1, to: PARENT, kind: 'review' }])
  })

  it('rework → next round with a rework intent to the executor', () => {
    const { run } = deliver(freshRun(), 3, 1200)
    const accepted = submitSignal(run, PARENT, 'rework', 'fix tests', 7, 1300)
    if (!accepted.ok) throw new Error(`rejected: ${accepted.code}`)
    const ended = commitTurnEnd(accepted.run, PARENT, 7, 'completed', 1400)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    expect(ended.run.phase).toBe('awaiting-delivery')
    expect(ended.run.round).toBe(2)
    expect(ended.intents).toEqual([{ runId: 'run-1', round: 2, to: EXECUTOR, kind: 'rework' }])
  })

  it('pass → completed with a terminal notice to the executor', () => {
    const { run } = deliver(freshRun(), 3, 1200)
    const accepted = submitSignal(run, PARENT, 'pass', 'looks good', 7, 1300)
    if (!accepted.ok) throw new Error('rejected')
    const ended = commitTurnEnd(accepted.run, PARENT, 7, 'completed', 1400)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    expect(ended.run.status).toBe('completed')
    expect(ended.run.endedAt).toBe(1400)
    expect(ended.intents).toEqual([{ runId: 'run-1', round: 1, to: EXECUTOR, kind: 'notice' }])
  })
})

describe('role and phase validation', () => {
  it('rejects a session outside the binding', () => {
    const result = submitSignal(freshRun(), OUTSIDER, 'deliver', 'hi', 1, 1100)
    expect(result).toMatchObject({ ok: false, code: 'unknown-role' })
  })

  it('executor cannot rework or pass; parent cannot deliver', () => {
    expect(submitSignal(freshRun(), EXECUTOR, 'pass', 'x', 1, 1100)).toMatchObject({ ok: false, code: 'outcome-not-allowed' })
    expect(submitSignal(freshRun(), PARENT, 'deliver', 'x', 1, 1100)).toMatchObject({ ok: false, code: 'outcome-not-allowed' })
  })

  it('rejects the right outcome in the wrong phase', () => {
    const { run } = deliver(freshRun(), 3, 1200)
    expect(submitSignal(run, EXECUTOR, 'deliver', 'again', 5, 1300)).toMatchObject({ ok: false, code: 'wrong-phase' })
    expect(submitSignal(freshRun(), PARENT, 'rework', 'early', 1, 1100)).toMatchObject({ ok: false, code: 'wrong-phase' })
  })
})

describe('ordinary turns never advance', () => {
  it('a turn end without a signal is ignored', () => {
    expect(commitTurnEnd(freshRun(), EXECUTOR, 9, 'completed', 1200)).toEqual({ kind: 'ignored' })
  })

  it('a turn end for a different turn is ignored', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 4, 1100)
    if (!accepted.ok) throw new Error('rejected')
    expect(commitTurnEnd(accepted.run, EXECUTOR, 5, 'completed', 1200)).toEqual({ kind: 'ignored' })
  })
})

describe('session-scoped signal ownership', () => {
  it('the counterpart ending its own same-numbered turn never commits the signal', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 1, 1100)
    if (!accepted.ok) throw new Error('rejected')
    // The reviewer's turn numbering is independent: its turn 1 ending first
    // must not advance — or even abort — the executor's pending signal.
    expect(commitTurnEnd(accepted.run, PARENT, 1, 'completed', 1200)).toEqual({ kind: 'ignored' })
    expect(commitTurnEnd(accepted.run, PARENT, 1, 'aborted', 1200)).toEqual({ kind: 'ignored' })
    expect(accepted.run.pendingSignal).toBeDefined()
    // The submitting session's turn end commits exactly once.
    const ended = commitTurnEnd(accepted.run, EXECUTOR, 1, 'completed', 1300)
    expect(ended.kind).toBe('advance')
  })

  it('an outsider session is never the signal owner', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 1, 1100)
    if (!accepted.ok) throw new Error('rejected')
    expect(signalBelongsTo(accepted.run.pendingSignal!, accepted.run, OUTSIDER)).toBe(false)
    expect(commitTurnEnd(accepted.run, OUTSIDER, 1, 'completed', 1200)).toEqual({ kind: 'ignored' })
  })

  it('legacy pending signals without a session still commit from either bound side', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 1, 1100)
    if (!accepted.ok) throw new Error('rejected')
    const legacy = { ...accepted.run, pendingSignal: { ...accepted.run.pendingSignal!, session: undefined } }
    expect(commitTurnEnd(legacy, PARENT, 1, 'completed', 1200).kind).toBe('advance')
  })
})

describe('failed or cancelled signal turns', () => {
  it('an aborted turn parks the run in paused-error without advancing', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 2, 1100)
    if (!accepted.ok) throw new Error('rejected')
    const ended = commitTurnEnd(accepted.run, EXECUTOR, 2, 'aborted', 1200)
    expect(ended.kind).toBe('aborted')
    if (ended.kind !== 'aborted') return
    expect(ended.run.status).toBe('paused-error')
    expect(ended.run.pendingSignal).toBeUndefined()
    expect(ended.run.phase).toBe('awaiting-delivery')
  })

  it('an errored turn behaves the same', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 2, 1100)
    if (!accepted.ok) throw new Error('rejected')
    expect(commitTurnEnd(accepted.run, EXECUTOR, 2, 'error', 1200).kind).toBe('aborted')
  })
})

describe('duplicate and late signals', () => {
  it('an identical repeat is a no-op; a different one is refused', () => {
    const first = submitSignal(freshRun(), EXECUTOR, 'deliver', 'done', 2, 1100)
    if (!first.ok) throw new Error('rejected')
    expect(submitSignal(first.run, EXECUTOR, 'deliver', 'done', 2, 1150)).toMatchObject({ ok: true, duplicate: true })
    expect(submitSignal(first.run, EXECUTOR, 'needs_user', 'wait', 2, 1150)).toMatchObject({ ok: false, code: 'turn-already-signaled' })
  })

  it('terminal and paused runs refuse every signal', () => {
    const { run } = deliver(freshRun(), 3, 1200)
    const passed = submitSignal(run, PARENT, 'pass', 'ok', 7, 1300)
    if (!passed.ok) throw new Error('rejected')
    const ended = commitTurnEnd(passed.run, PARENT, 7, 'completed', 1400)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    expect(submitSignal(ended.run, EXECUTOR, 'deliver', 'late', 9, 1500)).toMatchObject({ ok: false, code: 'run-not-active' })
    const paused = pauseRun(freshRun(), 1500)
    if (!paused.ok) throw new Error('pause failed')
    expect(submitSignal(paused.run, EXECUTOR, 'deliver', 'late', 9, 1500)).toMatchObject({ ok: false, code: 'run-not-active' })
  })
})

describe('round budget', () => {
  it('the last allowed delivery still goes to review in full', () => {
    let run = freshRun(2)
    let step = deliver(run, 2, 1200)
    run = step.run
    const accepted = submitSignal(run, PARENT, 'rework', 'more', 5, 1300)
    if (!accepted.ok) throw new Error(`rejected: ${accepted.code}`)
    const ended = commitTurnEnd(accepted.run, PARENT, 5, 'completed', 1400)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    // round 1 rework advanced to round 2; now deliver round 2 and rework again
    expect(ended.run.round).toBe(2)
    const second = deliver(ended.run, 8, 1500)
    const verdict = submitSignal(second.run, PARENT, 'rework', 'again', 10, 1600)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    const final = commitTurnEnd(verdict.run, PARENT, 10, 'completed', 1700)
    if (final.kind !== 'advance') throw new Error(final.kind)
    expect(final.run.status).toBe('paused-budget')
    expect(final.run.pendingRework).toEqual({ summary: 'again', round: 2 })
    expect(final.intents).toEqual([])
  })

  it('resume from paused-budget releases the deferred rework with one more round', () => {
    let run = freshRun(1)
    const step = deliver(run, 2, 1200)
    run = step.run
    const verdict = submitSignal(run, PARENT, 'rework', 'again', 5, 1300)
    if (!verdict.ok) throw new Error('rejected')
    const ended = commitTurnEnd(verdict.run, PARENT, 5, 'completed', 1400)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    expect(ended.run.status).toBe('paused-budget')
    const resumed = resumeRun(ended.run, {}, 2000)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.run.status).toBe('active')
    expect(resumed.run.round).toBe(2)
    expect(resumed.run.maxRounds).toBe(2)
    expect(resumed.intents).toEqual([{ runId: 'run-1', round: 2, to: EXECUTOR, kind: 'rework' }])
    // An explicit larger budget is honored.
    const bigger = resumeRun(ended.run, { newMaxRounds: 9 }, 2000)
    if (!bigger.ok) throw new Error('rejected')
    expect(bigger.run.maxRounds).toBe(9)
  })
})

describe('needs_user and manual control', () => {
  it('executor needs_user pauses with the note going to the parent', () => {
    const accepted = submitSignal(freshRun(), EXECUTOR, 'needs_user', '哪个分支？', 2, 1100)
    if (!accepted.ok) throw new Error('rejected')
    const ended = commitTurnEnd(accepted.run, EXECUTOR, 2, 'completed', 1200)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    expect(ended.run.status).toBe('paused-user')
    expect(ended.run.pausedBy).toBe('executor')
    expect(ended.intents).toEqual([{ runId: 'run-1', round: 1, to: PARENT, kind: 'notice' }])
  })

  it('parent needs_user pauses with the note going to the executor', () => {
    const { run } = deliver(freshRun(), 3, 1200)
    const accepted = submitSignal(run, PARENT, 'needs_user', '缩小范围？', 5, 1300)
    if (!accepted.ok) throw new Error('rejected')
    const ended = commitTurnEnd(accepted.run, PARENT, 5, 'completed', 1400)
    if (ended.kind !== 'advance') throw new Error(ended.kind)
    expect(ended.run.pausedBy).toBe('parent')
    expect(ended.intents).toEqual([{ runId: 'run-1', round: 1, to: EXECUTOR, kind: 'notice' }])
  })

  it('manual pause keeps the phase; resume with a note reaches the pause source', () => {
    const paused = pauseRun(freshRun(), 1500)
    if (!paused.ok) throw new Error('pause failed')
    expect(paused.run.status).toBe('paused-user')
    expect(paused.run.phase).toBe('awaiting-delivery')
    const resumed = resumeRun(paused.run, { message: '继续' }, 1600)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.run.status).toBe('active')
    expect(resumed.intents).toEqual([{ runId: 'run-1', round: 1, to: EXECUTOR, kind: 'resume' }])
  })

  it('resume clears the pause provenance so stale notes do not linger', () => {
    const parked: RunRecord = { ...freshRun(), status: 'paused-error', endNote: '投递失败（review → parent）：boom' }
    const resumed = resumeRun(parked, {}, 1700)
    if (!resumed.ok) throw new Error('resume failed')
    expect(resumed.run.status).toBe('active')
    expect(resumed.run.endNote).toBeUndefined()
    expect(resumed.run.pausedBy).toBeUndefined()
  })

  it('cancel works from every non-terminal status and clears pending state', () => {
    const cancelled = cancelRun(freshRun(), 1700)
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    expect(cancelled.run.status).toBe('cancelled')
    expect(cancelled.run.endedAt).toBe(1700)
    expect(cancelRun(cancelled.run, 1800).ok).toBe(false)
  })

  it('extendBudget only ever grows', () => {
    const run = freshRun(5)
    expect(extendBudget(run, 3, 1).maxRounds).toBe(5)
    expect(extendBudget(run, 8, 1).maxRounds).toBe(8)
  })
})

describe('templates', () => {
  it('substitutes known slots and leaves unknown ones visible', () => {
    expect(renderTemplate('第 {{round}}/{{maxRounds}} 轮：{{summary}} {{typo}}', {
      round: '2',
      maxRounds: '5',
      summary: '通过',
    })).toBe('第 2/5 轮：通过 {{typo}}')
  })
})

describe('turn-end auto-delivery', () => {
  it('snapshots the binding autoDeliver flag at run start', () => {
    expect(startRun(binding(), BODIES, '任务', 'run-1', 1).autoDeliver).toBeUndefined()
    expect(startRun({ ...binding(), autoDeliver: true }, BODIES, '任务', 'run-1', 1).autoDeliver).toBe(true)
  })

  it('submits a completed executor turn with a non-empty reply as a delivery', () => {
    const run = startRun({ ...binding(), autoDeliver: true }, BODIES, '任务', 'run-1', 1000)
    const outcome = autoDeliver(run, EXECUTOR, 4, '实现完成，测试全绿', 1100)
    expect(outcome.kind).toBe('advance')
    if (outcome.kind !== 'advance') return
    expect(outcome.run.phase).toBe('awaiting-review')
    expect(outcome.run.pendingSignal).toBeUndefined()
    expect(outcome.intents).toEqual([{ runId: 'run-1', round: 1, to: PARENT, kind: 'review' }])
    expect(outcome.run.history.at(-2)).toMatchObject({ kind: 'signal', detail: expect.stringContaining('auto') })
  })

  it('refuses anything but a completed executor delivery turn', () => {
    const run = startRun({ ...binding(), autoDeliver: true }, BODIES, '任务', 'run-1', 1000)
    // empty reply, other session, wrong phase, pending signal, inactive run
    expect(autoDeliver(run, EXECUTOR, 4, '', 1100).kind).toBe('ignored')
    expect(autoDeliver(run, PARENT, 4, 'hi', 1100).kind).toBe('ignored')
    expect(autoDeliver(run, OUTSIDER, 4, 'hi', 1100).kind).toBe('ignored')
    const reviewing = submitSignal(run, EXECUTOR, 'deliver', 'x', 4, 1100)
    if (!reviewing.ok) throw new Error('signal rejected')
    expect(autoDeliver(reviewing.run, EXECUTOR, 4, 'again', 1100).kind).toBe('ignored')
    const cancelled = cancelRun(run, 1050)
    if (!cancelled.ok) throw new Error('cancel failed')
    expect(autoDeliver(cancelled.run, EXECUTOR, 4, 'hi', 1100).kind).toBe('ignored')
  })
})

describe('bounded nudges', () => {
  it('mints one deliver nudge per round for the executor side', () => {
    const run = startRun({ ...binding(), autoDeliver: true }, BODIES, '任务', 'run-1', 1000)
    const first = dueNudge(run, 'deliver', 1100)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    expect(first.intent).toEqual({ runId: 'run-1', round: 1, to: EXECUTOR, kind: 'nudge' })
    expect(first.run.nudgeState).toEqual({ deliver: 1 })
    // second attempt in the same round is bounded away…
    expect(dueNudge(first.run, 'deliver', 1200).ok).toBe(false)
    // …and a new round earns exactly one more
    const reworked: RunRecord = { ...first.run, phase: 'awaiting-delivery', round: 2 }
    expect(dueNudge(reworked, 'deliver', 1300)).toMatchObject({ ok: true })
  })

  it('mints one review nudge per round for the reviewer side, phase-gated', () => {
    const { run } = deliver(startRun({ ...binding(), autoDeliver: true }, BODIES, '任务', 'run-1', 1000), 3, 1100)
    expect(dueNudge({ ...run, phase: 'awaiting-delivery' }, 'review', 1200).ok).toBe(false)
    const nudged = dueNudge(run, 'review', 1200)
    expect(nudged).toMatchObject({ ok: true })
    if (!nudged.ok) return
    expect(nudged.intent).toEqual({ runId: 'run-1', round: 1, to: PARENT, kind: 'nudge' })
    expect(dueNudge(nudged.run, 'review', 1300).ok).toBe(false)
    // sides are bounded independently within one round
    expect(dueNudge(nudged.run, 'deliver', 1300).ok).toBe(false)
  })
})
