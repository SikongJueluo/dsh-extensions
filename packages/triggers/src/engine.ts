/**
 * The pure loop state machine — every rule about rounds, roles, phases, and
 * stops lives here, expressed as total functions over plain records. No I/O,
 * no clocks, no Cordis: the runtime layer persists what these return and turns
 * the returned intents into queued prompts. Tests exercise the whole loop
 * through this seam.
 *
 * Core invariants:
 *
 * - A signal only advances the loop after the turn it belongs to ends
 *   `completed`. Any other end reason parks the run in `paused-error`; a
 *   missing signal never advances anything.
 * - Terminal and paused runs reject every signal ("late result" protection);
 *   a stale run id cannot revive anything.
 * - One delivery + its review is one round. The budget blocks the NEXT
 *   execution round, never the review of the last allowed delivery: a rework
 *   verdict at the budget edge becomes `paused-budget` holding the deferred
 *   rework, resumable by raising the budget.
 *
 * @module dsh-triggers/engine
 */
import type {
  BindingRecord,
  DeliveryKind,
  RunHistoryEntry,
  RunPhase,
  RunRecord,
  RunStatus,
  RunTemplateBodies,
  SignalOutcome,
} from './model.js'

/** How many history lines a run keeps (oldest fall off; session logs stay full). */
const HISTORY_LIMIT = 60

/** One queued prompt the runtime should deliver (content composed outside). */
export interface DeliveryIntent {
  readonly runId: string
  readonly round: number
  readonly to: string
  readonly kind: DeliveryKind
}

/** Why `submitSignal` refused a call; the tool surfaces `message` verbatim. */
export type SignalErrorCode =
  | 'run-not-active'
  | 'unknown-role'
  | 'outcome-not-allowed'
  | 'wrong-phase'
  | 'turn-already-signaled'

export type SignalResult =
  | { readonly ok: true; readonly run: RunRecord; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: SignalErrorCode; readonly message: string }

/** What a session-log `turn/end` did to a run. */
export type TurnEndResult =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'aborted'; readonly run: RunRecord }
  | { readonly kind: 'advance'; readonly run: RunRecord; readonly intents: readonly DeliveryIntent[] }

export type ControlErrorCode = 'run-not-pausable' | 'run-not-resumable'

/** History append with the bounded tail. */
function withHistory(run: RunRecord, entry: RunHistoryEntry): RunRecord {
  const history = [...run.history, entry]
  return { ...run, history: history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history }
}

/** Outcomes each role may signal, by the phase the run must be in. */
const ALLOWED: Record<'executor' | 'parent', Partial<Record<SignalOutcome, RunPhase>>> = {
  executor: { deliver: 'awaiting-delivery', needs_user: 'awaiting-delivery' },
  parent: { rework: 'awaiting-review', pass: 'awaiting-review', needs_user: 'awaiting-review' },
}

/** Which of the two bound sessions is the caller; `undefined` = neither. */
export function roleOf(run: RunRecord, callerSession: string): 'executor' | 'parent' | undefined {
  if (callerSession === run.executor) return 'executor'
  if (callerSession === run.parent) return 'parent'
  return undefined
}

/** Mint a run in its first execution round. Pure: caller supplies ids and clock. */
export function startRun(
  binding: BindingRecord,
  templates: RunTemplateBodies,
  task: string,
  runId: string,
  now: number,
): RunRecord {
  return {
    id: runId,
    bindingId: binding.id,
    task,
    status: 'active',
    phase: 'awaiting-delivery',
    round: 1,
    maxRounds: binding.maxRounds,
    executor: binding.executor,
    parent: binding.parent,
    templates,
    startedAt: now,
    history: [{ at: now, kind: 'started', detail: `round budget ${binding.maxRounds}` }],
  }
}

/**
 * Accept (or refuse) one `trigger_signal` call. On success the run holds the
 * signal as pending — nothing advances until `commitTurnEnd` sees the turn's
 * `completed` end, so a still-running session is never pre-empted.
 */
export function submitSignal(
  run: RunRecord,
  callerSession: string,
  outcome: SignalOutcome,
  summary: string,
  turn: number,
  now: number,
): SignalResult {
  if (run.status !== 'active') {
    return {
      ok: false,
      code: 'run-not-active',
      message: `本次运行已${statusLabel(run.status)}，不再接受交接信号。`,
    }
  }
  const role = roleOf(run, callerSession)
  if (role === undefined) {
    return { ok: false, code: 'unknown-role', message: '该会话不属于本次运行的执行者或审核者。' }
  }
  const requiredPhase = ALLOWED[role][outcome]
  if (requiredPhase === undefined) {
    const allowed = Object.keys(ALLOWED[role]).join(' / ')
    return {
      ok: false,
      code: 'outcome-not-allowed',
      message: `${role === 'executor' ? '执行者' : '审核者'}只能提交：${allowed}。`,
    }
  }
  if (run.phase !== requiredPhase) {
    return {
      ok: false,
      code: 'wrong-phase',
      message: `当前阶段是「${phaseLabel(run.phase)}」，此时不能提交 ${outcome}。`,
    }
  }
  const pending = run.pendingSignal
  if (pending !== undefined) {
    if (pending.outcome === outcome && pending.summary === summary) {
      return { ok: true, run, duplicate: true }
    }
    return {
      ok: false,
      code: 'turn-already-signaled',
      message: `本回合已提交过 ${pending.outcome} 信号；如需更改，请在下一回合说明并重新调用。`,
    }
  }
  const accepted: RunRecord = withHistory(run, {
    at: now,
    kind: 'signal',
    detail: `${role}:${outcome} (turn ${turn})`,
  })
  return {
    ok: true,
    duplicate: false,
    run: { ...accepted, pendingSignal: { outcome, summary, turn, at: now } },
  }
}

/**
 * Fold one session-log `turn/end` into a run. Only the turn the pending
 * signal belongs to, ending `completed`, commits; anything else with a
 * pending signal parks the run in `paused-error` instead of guessing.
 */
export function commitTurnEnd(run: RunRecord, turn: number, reasonKind: string, now: number): TurnEndResult {
  const pending = run.pendingSignal
  if (pending === undefined || pending.turn !== turn) return { kind: 'ignored' }
  const base = { ...run, pendingSignal: undefined }
  if (reasonKind !== 'completed') {
    return {
      kind: 'aborted',
      run: withHistory(
        { ...base, status: 'paused-error', endNote: `信号所在回合以 ${reasonKind} 结束，未按正常交接推进` },
        { at: now, kind: 'pause', detail: `signal turn ended ${reasonKind}` },
      ),
    }
  }
  switch (pending.outcome) {
    case 'deliver': {
      const advanced: RunRecord = withHistory(
        { ...base, phase: 'awaiting-review' },
        { at: now, kind: 'advance', detail: `round ${run.round} → review` },
      )
      return {
        kind: 'advance',
        run: advanced,
        intents: [{ runId: run.id, round: run.round, to: run.parent, kind: 'review' }],
      }
    }
    case 'rework': {
      if (run.round < run.maxRounds) {
        const next = run.round + 1
        const advanced: RunRecord = withHistory(
          { ...base, phase: 'awaiting-delivery', round: next },
          { at: now, kind: 'advance', detail: `round ${next} rework` },
        )
        return {
          kind: 'advance',
          run: advanced,
          intents: [{ runId: run.id, round: next, to: run.executor, kind: 'rework' }],
        }
      }
      return {
        kind: 'advance',
        run: withHistory(
          { ...base, status: 'paused-budget', pendingRework: { summary: pending.summary, round: run.round } },
          { at: now, kind: 'pause', detail: 'rework at round budget' },
        ),
        intents: [],
      }
    }
    case 'pass': {
      return {
        kind: 'advance',
        run: withHistory(
          { ...base, status: 'completed', endedAt: now, endNote: '审核通过' },
          { at: now, kind: 'end', detail: 'pass' },
        ),
        intents: [{ runId: run.id, round: run.round, to: run.executor, kind: 'notice' }],
      }
    }
    case 'needs_user': {
      const pausedBy = run.phase === 'awaiting-delivery' ? 'executor' : 'parent'
      return {
        kind: 'advance',
        run: withHistory(
          { ...base, status: 'paused-user', pausedBy },
          { at: now, kind: 'pause', detail: `needs_user by ${pausedBy}` },
        ),
        intents: [
          { runId: run.id, round: run.round, to: pausedBy === 'executor' ? run.parent : run.executor, kind: 'notice' },
        ],
      }
    }
  }
}

/** Manually pause an active run (the waiting side keeps waiting; nothing is cancelled). */
export function pauseRun(run: RunRecord, now: number): { ok: true; run: RunRecord } | { ok: false; message: string } {
  if (run.status !== 'active') return { ok: false, message: `运行已处于 ${statusLabel(run.status)} 状态。` }
  const pausedBy: RunRecord['pausedBy'] = run.phase === 'awaiting-delivery' ? 'executor' : 'parent'
  return {
    ok: true,
    run: withHistory(
      { ...run, status: 'paused-user', pausedBy, pendingSignal: undefined },
      { at: now, kind: 'pause', detail: 'manual' },
    ),
  }
}

/** Cancel a run permanently (any non-terminal status). */
export function cancelRun(run: RunRecord, now: number): { ok: true; run: RunRecord } | { ok: false; message: string } {
  if (run.status === 'completed' || run.status === 'cancelled') {
    return { ok: false, message: '运行已结束，无需取消。' }
  }
  return {
    ok: true,
    run: withHistory(
      { ...run, status: 'cancelled', endedAt: now, endNote: '手动取消', pendingSignal: undefined, pendingRework: undefined },
      { at: now, kind: 'end', detail: 'cancelled' },
    ),
  }
}

export interface ResumeOptions {
  /** A user note delivered to the side that asked (or that acts next). */
  readonly message?: string
  /** New budget for `paused-budget`; defaults to exactly one more round. */
  readonly newMaxRounds?: number
}

/**
 * Resume a paused run. `paused-user` re-activates in place (an optional note
 * goes to the pause's signaler); `paused-budget` raises the budget (default:
 * the one round the deferred rework needs) and releases the deferred rework;
 * `paused-error` re-activates in the phase it parked in.
 */
export function resumeRun(
  run: RunRecord,
  options: ResumeOptions,
  now: number,
): { ok: true; run: RunRecord; intents: readonly DeliveryIntent[] } | { ok: false; code: ControlErrorCode; message: string } {
  if (run.status === 'active') return { ok: false, code: 'run-not-resumable', message: '运行仍在进行中。' }
  if (run.status === 'completed' || run.status === 'cancelled') {
    return { ok: false, code: 'run-not-resumable', message: '运行已结束，不能恢复。' }
  }
  if (run.status === 'paused-budget') {
    // Never shrink: an explicit number wins only above both the deferred
    // round and the budget already on record.
    const target = Math.max(options.newMaxRounds ?? 0, run.round + 1, run.maxRounds)
    const pending = run.pendingRework
    const resumed: RunRecord = withHistory(
      {
        ...run,
        status: 'active',
        phase: 'awaiting-delivery',
        round: run.round + 1,
        maxRounds: target,
        pendingRework: undefined,
      },
      { at: now, kind: 'resume', detail: `budget ${run.maxRounds} → ${target}, round ${run.round + 1}` },
    )
    // With a deferred rework held, resuming releases it; otherwise the user
    // paused mid-budget without a verdict and the executor just continues.
    const intents: DeliveryIntent[] = pending !== undefined
      ? [{ runId: run.id, round: run.round + 1, to: run.executor, kind: 'rework' }]
      : []
    return { ok: true, run: resumed, intents }
  }
  const resumed: RunRecord = withHistory(
    { ...run, status: 'active' },
    { at: now, kind: 'resume' },
  )
  if (options.message === undefined || options.message.length === 0) return { ok: true, run: resumed, intents: [] }
  // `pausedBy` records the ROLE that asked; map it back to its session id.
  const role = run.pausedBy ?? (run.phase === 'awaiting-delivery' ? 'executor' : 'parent')
  const to = role === 'executor' ? run.executor : run.parent
  return {
    ok: true,
    run: resumed,
    intents: [{ runId: run.id, round: run.round, to, kind: 'resume' }],
  }
}

/** Raise the budget of a still-running or paused run without touching anything else. */
export function extendBudget(run: RunRecord, newMaxRounds: number, now: number): RunRecord {
  if (newMaxRounds <= run.maxRounds) return run
  return withHistory({ ...run, maxRounds: newMaxRounds }, { at: now, kind: 'note', detail: `budget → ${newMaxRounds}` })
}

/** Replace `{{key}}` slots in a template body; unknown keys stay visible. */
export function renderTemplate(body: string, vars: Readonly<Record<string, string>>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (Object.hasOwn(vars, key) ? vars[key]! : whole))
}

/** Human labels (UI copy shares them). */
export function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'active': return '进行中'
    case 'paused-user': return '等待用户'
    case 'paused-budget': return '轮次用尽待续'
    case 'paused-error': return '异常暂停'
    case 'completed': return '已完成'
    case 'cancelled': return '已取消'
  }
}

/** Human label of a phase. */
export function phaseLabel(phase: RunPhase): string {
  return phase === 'awaiting-delivery' ? '等待执行者交付' : '等待审核'
}
