/**
 * The host orchestrator: one Cordis service (`ctx.triggerBindings`) that owns
 * the loop runtime — signal intake from the tool, turn tracking over
 * `session/event`, commit + delivery over the session controller's queue,
 * crash recovery, and the CRUD/control surface the browser channel and the
 * handoff integration share.
 *
 * Delivery reliability contract: every queued prompt is persisted as a
 * Delivery record with its session-controller `requestId` BEFORE the prompt
 * call; retries (crash recovery, manual redeliver) reuse the same requestId,
 * which the controller dedupes against already-queued/logged messages. A
 * failed or timed-out send parks the run in `paused-error` instead of
 * guessing. Nudges are the one exception: they are informational and bounded
 * (once per round per side), so a failed nudge only logs.
 *
 * Turn-event automation (autoDeliver runs, handoff binds by default): the
 * executor's turn that ends `completed` with no explicit signal, no active
 * goal in its session, and a non-empty final assistant reply is submitted for
 * review with that reply as the delivery summary — the executor finishes its
 * answer and the loop moves on its own. Missing conclusions (either side) get
 * ONE bounded reminder per round; verdicts always require the tool.
 *
 * @module dsh-triggers/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { PACKAGE_NAME, SERVICE_NAME } from './identity.js'
import {
  DEFAULT_MAX_ROUNDS,
  SIGNAL_OUTCOMES,
  defaultTemplateRefs,
  type BindingRecord,
  type DeliveryRecord,
  type RunRecord,
  type SignalOutcome,
  type TemplateRecord,
} from './model.js'
import {
  autoDeliver,
  cancelRun,
  commitTurnEnd,
  dueNudge,
  extendBudget,
  kindLabel,
  pauseRun,
  phaseLabel,
  resumeRun,
  signalBelongsTo,
  startRun,
  statusLabel,
  submitSignal,
  type DeliveryIntent,
} from './engine.js'
import { composeDeliveryPrompt, nudgeLine } from './prompts.js'
import { openStore, type TriggerStore } from './store.js'

/** Plugin-row configuration. */
export interface TriggerConfig {
  /** Budget for one queue-prompt send before the delivery is marked failed (ms). */
  deliverTimeoutMs?: number
}

/** What `bindReviewLoop` (the handoff integration) asks for and gets back. */
export interface BindReviewLoopRequest {
  /** Free-form task label carried by the run (and the start template's `{{task}}`). */
  readonly task: string
  readonly executorSession: string
  readonly parentSession: string
  /** Round budget for the run; clamped to 1..50, default {@link DEFAULT_MAX_ROUNDS}. */
  readonly maxRounds?: number
  /** Queue the start prompt to the executor (standalone starts); handoff sends its own brief. */
  readonly deliverStart?: boolean
  /**
   * Auto-submit the executor's completed turns (default true): a handoff
   * executor is single-purpose, so its normal turn end IS its delivery.
   */
  readonly autoDeliver?: boolean
}

/** Handoff-facing surface (structural, so handoff needs no type import). */
export interface TriggerBindingsService {
  bindReviewLoop(request: BindReviewLoopRequest): Promise<{ bindingId: string, runId: string }>
}

/** A session row for the client pickers. */
export interface SessionRow {
  readonly id: string
  readonly updatedAt: number
  readonly running: boolean
  readonly cwd?: string
  /** Folded session title, when the host summary carries one. */
  readonly title?: string
}

const MAX_ROUNDS_LIMIT = 50
const SNAPSHOT_RUN_LIMIT = 50
const SNAPSHOT_DELIVERY_LIMIT = 120
/** Ceiling for the executor reply text reused as an auto-delivery summary. */
const AUTO_SUMMARY_LIMIT = 6000

/** Pull the plain text out of one message content block list (join with newlines). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown, text?: unknown }
    if (type === 'text' && typeof text === 'string' && text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}

/** The full UI snapshot the channel serves. */
export interface TriggerSnapshot {
  readonly templates: readonly TemplateRecord[]
  readonly bindings: readonly BindingRecord[]
  readonly runs: readonly RunRecord[]
  readonly deliveries: readonly DeliveryRecord[]
}

/**
 * The trigger runtime. Constructed once per plugin fiber; every public method
 * awaits the internal readiness promise, so a handoff spawn racing the domain
 * open simply waits.
 *
 * Members are TypeScript-`private`, never ES `#` privates: cross-plugin
 * callers resolve this service through `ctx.get()`, which hands out a Cordis
 * trace proxy, and ES private brand checks reject that proxy's receiver —
 * `TypeError: Receiver must be an instance of class …` — even though every
 * ordinary member forwards fine.
 */
export class TriggerService extends Service implements TriggerBindingsService {
  private config: TriggerConfig
  private store: TriggerStore | undefined
  private readyPromise: Promise<void>
  /** Current turn per session, maintained from `turn/start` events. */
  private currentTurn = new Map<string, number>()
  /**
   * Latest assistant reply per session (from `assistant/message` events),
   * EMPTY final messages included. Consumed at `turn/end`: the last assistant
   * message of a completed turn is the auto-delivery summary — empty means no
   * deliverable final reply (nudge), never an earlier intermediate message.
   */
  private lastReply = new Map<string, { turn: number, text: string }>()
  /**
   * Sessions whose current goal is in durable phase `active` (folded from
   * `goal/change` events): a goal driver may continue the session with more
   * rounds after this turn, so its turn ends must not auto-deliver.
   */
  private goalActive = new Set<string>()
  /** Per-session promise chain keeping turn-end commits serial. */
  private chains = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: TriggerConfig) {
    super(ctx, SERVICE_NAME)
    this.config = config
    this.readyPromise = this.init()
    ctx.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event))
  }

  private async init(): Promise<void> {
    this.store = await openStore(this.ctx)
    await this.recover()
    this.ctx.logger(PACKAGE_NAME).info('trigger runtime ready', {
      bindings: this.store.bindings.size,
      runs: this.store.runs.size,
    })
  }

  /** Await readiness; rethrows the init failure so callers fail loud. */
  private async ready(): Promise<TriggerStore> {
    await this.readyPromise
    const store = this.store
    if (store === undefined) throw new Error('trigger store unavailable')
    return store
  }

  /**
   * Startup recovery: a signal that never saw its turn end cannot be trusted
   * (the plugin missed the event), so its run parks in `paused-error` for the
   * user; pending deliveries are re-sent under their original requestId.
   */
  private async recover(): Promise<void> {
    const store = this.store
    if (store === undefined) return
    const now = Date.now()
    const resend: DeliveryRecord[] = []
    for (const [id, run] of store.runs.entries()) {
      if (run.status === 'active' && run.pendingSignal !== undefined) {
        await store.runs.put(id, {
          ...run,
          status: 'paused-error',
          pendingSignal: undefined,
          endNote: '插件重启时存在未决信号，无法确认其回合是否正常结束；请检查后恢复或取消',
          history: [...run.history, { at: now, kind: 'pause', detail: 'restart with pending signal' }],
        })
        this.ctx.logger(PACKAGE_NAME).warn('run parked after restart with a pending signal', { runId: id })
      }
    }
    for (const [, delivery] of store.deliveries.entries()) {
      if (delivery.state === 'pending') resend.push(delivery)
    }
    // Runs inside init: the store is handed in, since sendQueued's own
    // readiness wait would deadlock on the very init calling it. Nudges keep
    // their best-effort semantics here too: a reminder that fails to re-send
    // must not park an otherwise healthy run.
    for (const delivery of resend) {
      await this.sendQueued(delivery, store, delivery.kind === 'nudge')
    }
    if (resend.length > 0) {
      this.ctx.logger(PACKAGE_NAME).info('re-sent pending deliveries after restart', { count: resend.length })
    }
  }

  // ── session events ───────────────────────────────────────────────────────

  private onSessionEvent(sessionId: string, event: { readonly type: string, readonly data: unknown }): void {
    if (event.type === 'turn/start') {
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      if (typeof turn === 'number') this.currentTurn.set(sessionId, turn)
      return
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { turn?: unknown, message?: { content?: unknown } } | undefined
      const turn = data?.turn
      if (typeof turn !== 'number') return
      // Track EVERY assistant message of the turn, empty ones included: the
      // LAST one decides whether the turn has a deliverable final reply, and
      // an empty final message must not fall back to an earlier intermediate
      // text.
      this.lastReply.set(sessionId, { turn, text: contentText(data?.message?.content) })
      return
    }
    if (event.type === 'goal/change') {
      // GoalChangeMeta: operation 'clear' drops the goal; otherwise phase
      // 'active' means a continuation round may follow this turn.
      const data = event.data as { operation?: unknown, goal?: { phase?: unknown } } | undefined
      if (data?.operation !== 'clear' && data?.goal?.phase === 'active') this.goalActive.add(sessionId)
      else this.goalActive.delete(sessionId)
      return
    }
    if (event.type !== 'turn/end') return
    const data = event.data as { turn?: unknown, reason?: { kind?: unknown } } | undefined
    const turn = data?.turn
    const reasonKind = data?.reason?.kind
    if (typeof turn !== 'number' || typeof reasonKind !== 'string') return
    this.currentTurn.delete(sessionId)
    // Consume the tracked reply synchronously: a replayed turn/end must not
    // see (and re-deliver) the same final answer twice.
    const tracked = this.lastReply.get(sessionId)
    const reply = tracked !== undefined && tracked.turn === turn ? tracked : undefined
    this.lastReply.delete(sessionId)
    // Chain per session so a fast next turn can never interleave a commit.
    const chained = (this.chains.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        await this.commitTurnEnd(sessionId, turn, reasonKind, reply)
      })
      .catch((error: unknown) => {
        this.ctx.logger(PACKAGE_NAME).warn('turn-end commit failed', { sessionId, turn, error: String(error) })
      })
      .finally(() => {
        if (this.chains.get(sessionId) === chained) this.chains.delete(sessionId)
      })
    this.chains.set(sessionId, chained)
  }

  /**
   * Commit every active run whose pending signal belongs to this session AND
   * turn. Session identity matters: the two sides number their turns
   * independently, so the counterpart ending its own same-numbered turn must
   * never commit (or abort) a signal it did not submit.
   *
   * After the explicit-signal pass, a `completed` turn may still move runs
   * forward on its own: an autoDeliver run submits the executor's final reply
   * as the delivery, and either side's missing conclusion earns one bounded
   * nudge per round. Nothing here touches a turn that ended abnormally — an
   * aborted/blocked/error end is user-visible and never a delivery.
   */
  private async commitTurnEnd(
    sessionId: string,
    turn: number,
    reasonKind: string,
    reply: { readonly turn: number, readonly text: string } | undefined,
  ): Promise<void> {
    const store = await this.ready()
    const now = Date.now()
    // Snapshot BEFORE the commit pass clears pending signals: whether this
    // (session, turn) already carried an explicit signal decides if the
    // automation pass may look at the turn at all.
    const turnSpokenFor = [...store.runs.entries()].some(([, run]) =>
      run.pendingSignal !== undefined && run.pendingSignal.session === sessionId && run.pendingSignal.turn === turn)
    // One turn advances at most ONE run. The auto pass may only claim a turn
    // that no explicit signal owns AND that exactly one autoDeliver run is
    // waiting on: with several candidates the same reply cannot tell which
    // task it delivers, so none is advanced (each candidate instead gets its
    // bounded missing-signal nudge — the executor must then signal the run it
    // actually delivered for).
    const autoCandidates = turnSpokenFor
      ? []
      : [...store.runs.entries()]
        .filter(([, run]) => run.status === 'active' && run.pendingSignal === undefined
          && sessionId === run.executor && run.phase === 'awaiting-delivery' && run.autoDeliver === true)
        .map(([id]) => id)
    const autoWinner = autoCandidates.length === 1 ? autoCandidates[0]! : undefined
    const autoAmbiguous = autoCandidates.length > 1
    for (const [id, run] of store.runs.entries()) {
      if (run.status !== 'active') continue
      if (run.pendingSignal !== undefined) {
        if (!signalBelongsTo(run.pendingSignal, run, sessionId)) continue
        if (run.pendingSignal.turn !== turn) continue
        const summary = run.pendingSignal.summary
        const outcome = commitTurnEnd(run, sessionId, turn, reasonKind, now)
        if (outcome.kind === 'ignored') continue
        await store.runs.put(id, outcome.run)
        if (outcome.kind === 'aborted') {
          this.ctx.logger(PACKAGE_NAME).warn('signal turn ended abnormally; run parked', {
            runId: id,
            reason: reasonKind,
          })
          continue
        }
        for (const intent of outcome.intents) {
          await this.deliver(intent, outcome.run, intent.kind === 'start' ? undefined : summary)
        }
        continue
      }
      if (reasonKind !== 'completed') continue
      if (sessionId === run.executor && run.phase === 'awaiting-delivery') {
        // Mid-goal turns look exactly like finished ones at turn/end; the
        // driver may continue, so hold automation until the goal settles.
        if (this.goalActive.has(sessionId)) continue
        if (run.autoDeliver === true) {
          // The turn was spent on another run's explicit signal: nothing to
          // interpret here, and no reminder either — the executor already
          // spoke for one loop this turn.
          if (turnSpokenFor) continue
          // Several auto runs are waiting on this one session: the reply
          // cannot be attributed; ask for an explicit signal per run. The
          // reminder must carry its own instructions — the standing block of
          // an autoDeliver run promises a normal turn end delivers itself,
          // which would cancel out the required recovery path.
          if (autoAmbiguous) {
            await this.sendDeliverNudge(store, run, id, now, 'deliver-ambiguous')
            continue
          }
          if (autoWinner === id) {
            const summary = this.autoSummary(reply, turn)
            if (summary.length > 0) {
              const outcome = autoDeliver(run, sessionId, turn, summary, now)
              if (outcome.kind === 'advance') {
                await store.runs.put(id, outcome.run)
                this.ctx.logger(PACKAGE_NAME).info('executor turn auto-delivered', { runId: id, turn })
                for (const intent of outcome.intents) {
                  await this.deliver(intent, outcome.run, summary)
                }
              }
              continue
            }
            // The turn's LAST assistant message carried no deliverable text
            // (empty, whitespace-only, or none at all): never fall back to an
            // earlier intermediate message.
            await this.sendDeliverNudge(store, run, id, now, 'deliver-empty')
            continue
          }
          // Not the winner and not ambiguous (this run wasn't an eligible
          // candidate for this turn at all): leave it untouched.
          continue
        }
        await this.sendDeliverNudge(store, run, id, now, 'deliver-missing-signal')
        continue
      }
      if (sessionId === run.parent && run.phase === 'awaiting-review') {
        // Only nudge once the review prompt itself has landed; a turn that
        // ended before the delivery was sent never saw the material.
        const reviewSent = [...store.deliveries.entries()]
          .some(([, delivery]) => delivery.runId === id && delivery.round === run.round
            && delivery.kind === 'review' && delivery.state === 'sent')
        if (!reviewSent || this.goalActive.has(sessionId)) continue
        const nudge = dueNudge(run, 'review', now)
        if (!nudge.ok) continue
        await store.runs.put(id, nudge.run)
        this.ctx.logger(PACKAGE_NAME).info('review nudge sent', { runId: id, round: run.round })
        await this.deliver(nudge.intent, nudge.run, nudgeLine(nudge.run, 'review'), true)
      }
    }
  }

  /**
   * The auto-delivery summary of this turn: the tracked LAST assistant message
   * of the turn, trimmed. Empty when the turn had no assistant text at all or
   * its final message was empty/whitespace-only — an intermediate message from
   * an earlier step must never stand in for a missing final reply.
   */
  private autoSummary(reply: { readonly turn: number, readonly text: string } | undefined, turn: number): string {
    if (reply === undefined || reply.turn !== turn) return ''
    const text = reply.text.trim()
    if (text.length === 0) return ''
    return text.length > AUTO_SUMMARY_LIMIT
      ? `${text.slice(0, AUTO_SUMMARY_LIMIT)}\n…（执行者回复超长，已截断；完整内容见执行会话日志）`
      : text
  }

  /** One bounded executor-side reminder (missing signal / empty final reply / ambiguous attribution). */
  private async sendDeliverNudge(
    store: TriggerStore,
    run: RunRecord,
    runId: string,
    now: number,
    line: 'deliver-missing-signal' | 'deliver-empty' | 'deliver-ambiguous',
  ): Promise<void> {
    const nudge = dueNudge(run, 'deliver', now)
    if (!nudge.ok) return
    await store.runs.put(runId, nudge.run)
    this.ctx.logger(PACKAGE_NAME).info('deliver nudge sent', { runId, round: run.round, line })
    await this.deliver(nudge.intent, nudge.run, nudgeLine(nudge.run, line), true, line === 'deliver-ambiguous')
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  /**
   * Persist the intent, then send it; a failed send parks the run — unless
   * `bestEffort` (nudges): a bounded reminder failing to queue must not freeze
   * an otherwise healthy loop. `standalone` keeps the composed prompt free of
   * the standing instructions block (see composeDeliveryPrompt).
   */
  private async deliver(
    intent: DeliveryIntent,
    run: RunRecord,
    summary: string | undefined,
    bestEffort = false,
    standalone = false,
  ): Promise<void> {
    const store = await this.ready()
    const content = composeDeliveryPrompt(intent, run, summary, standalone)
    const delivery: DeliveryRecord = {
      id: crypto.randomUUID(),
      runId: intent.runId,
      round: intent.round,
      to: intent.to,
      kind: intent.kind,
      requestId: `trg-${crypto.randomUUID()}`,
      state: 'pending',
      content,
      createdAt: Date.now(),
    }
    await store.deliveries.put(delivery.id, delivery)
    await this.sendQueued(delivery, undefined, bestEffort)
  }

  /** One idempotent send attempt for a persisted delivery record. */
  private async sendQueued(delivery: DeliveryRecord, storeOverride?: TriggerStore, bestEffort = false): Promise<boolean> {
    const store = storeOverride ?? await this.ready()
    const timeoutMs = this.config.deliverTimeoutMs ?? 120_000
    let error: string | undefined
    try {
      const request: SessionPromptRequest = {
        requestId: delivery.requestId as SessionRequestId,
        sessionId: delivery.to as SessionPromptRequest['sessionId'],
        mode: 'queue',
        content: [{ type: 'text', text: delivery.content }],
      }
      // The abort signal bounds the wait; a timed-out admission is treated as
      // failed and parked (a later redeliver reuses the same requestId).
      await this.ctx.sessionController.prompt(request, AbortSignal.timeout(timeoutMs))
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    if (error === undefined) {
      await store.deliveries.put(delivery.id, { ...delivery, state: 'sent', sentAt: Date.now() })
      return true
    }
    await store.deliveries.put(delivery.id, { ...delivery, state: 'failed', error })
    if (bestEffort) {
      this.ctx.logger(PACKAGE_NAME).warn('nudge delivery failed (best effort; run untouched)', {
        deliveryId: delivery.id,
        runId: delivery.runId,
        error,
      })
      return false
    }
    // A delivery the queue refused leaves the run's state undecidable: park it
    // for the user instead of re-sending blindly.
    const run = store.runs.get(delivery.runId)
    if (run !== undefined && run.status === 'active') {
      await store.runs.put(run.id, {
        ...run,
        status: 'paused-error',
        endNote: `投递失败（${delivery.kind} → ${delivery.to}）：${error}`,
        history: [...run.history, { at: Date.now(), kind: 'pause', detail: `delivery failed: ${error}` }],
      })
    }
    this.ctx.logger(PACKAGE_NAME).warn('delivery failed; run parked', {
      deliveryId: delivery.id,
      runId: delivery.runId,
      error,
    })
    return false
  }

  // ── tool intake ──────────────────────────────────────────────────────────

  /** `trigger_signal` entry: validate, record the pending signal, wait for the turn. */
  async signal(
    callerSession: string,
    args: { runId: unknown, outcome: unknown, summary: unknown },
  ): Promise<{ ok: true, note: string } | { ok: false, error: string }> {
    const store = await this.ready()
    if (typeof args.runId !== 'string' || args.runId.length === 0) return { ok: false, error: 'runId 缺失。' }
    if (!SIGNAL_OUTCOMES.includes(args.outcome as SignalOutcome)) {
      return { ok: false, error: `outcome 必须是 ${SIGNAL_OUTCOMES.join(' / ')} 之一。` }
    }
    if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
      return { ok: false, error: 'summary 不能为空：写明结论与证据指引。' }
    }
    const run = store.runs.get(args.runId)
    if (run === undefined) {
      return { ok: false, error: `没有 runId=${args.runId} 的运行；请核对触发器提示中的 runId。` }
    }
    const turn = this.currentTurn.get(callerSession)
    if (turn === undefined) {
      return { ok: false, error: '当前回合状态未知（插件可能刚重启）；请在本回合结束后的下一回合重新提交。' }
    }
    // One turn carries one verdict per session: a session already pending on
    // this turn (for any run) cannot also speak for another run, and the
    // signal tool ends the turn after acceptance, so this never bites a real
    // single-loop caller.
    for (const [, other] of store.runs.entries()) {
      if (other.id === run.id || other.status !== 'active' || other.pendingSignal === undefined) continue
      if (other.pendingSignal.session === callerSession && other.pendingSignal.turn === turn) {
        return {
          ok: false,
          error: `本回合已为运行 ${other.id} 提交过信号；一个回合只能推进一个运行，请在下一回合再提交。`,
        }
      }
    }
    const result = submitSignal(run, callerSession, args.outcome as SignalOutcome, args.summary.trim(), turn, Date.now())
    if (!result.ok) return { ok: false, error: result.message }
    if (result.duplicate) {
      return { ok: true, note: '本回合已提交过相同信号，保持不变；回合结束后将按其推进。' }
    }
    await store.runs.put(run.id, result.run)
    return {
      ok: true,
      note: `已接受 ${args.outcome} 信号；本回合正常结束后将转交对方处理。现在停止输出，等待对方结果。`,
    }
  }

  // ── handoff integration ──────────────────────────────────────────────────

  async bindReviewLoop(request: BindReviewLoopRequest): Promise<{ bindingId: string, runId: string }> {
    if (request.executorSession === request.parentSession || request.executorSession.length === 0 || request.parentSession.length === 0) {
      throw new Error('executor 与 parent 必须是两个不同的会话')
    }
    const { run } = await this.createLoop(
      request.task,
      request.executorSession,
      request.parentSession,
      request.maxRounds,
      undefined,
      undefined,
      request.autoDeliver ?? true,
    )
    if (request.deliverStart === true) {
      await this.deliver({ runId: run.id, round: 1, to: run.executor, kind: 'start' }, run, undefined)
    }
    return { bindingId: run.bindingId, runId: run.id }
  }

  /** Shared creation path for handoff bindings and UI `run.start`. */
  private async createLoop(
    task: string,
    executor: string,
    parent: string,
    maxRounds: number | undefined,
    bindingName: string | undefined,
    templateRefs?: { start: string, review: string, rework: string },
    autoDeliver = false,
  ): Promise<{ binding: BindingRecord, run: RunRecord }> {
    const store = await this.ready()
    const now = Date.now()
    const binding: BindingRecord = {
      id: `bnd-${crypto.randomUUID()}`,
      name: bindingName?.trim().length ? bindingName.trim() : `循环 · ${task.slice(0, 30)}`,
      executor,
      parent,
      maxRounds: Math.min(MAX_ROUNDS_LIMIT, Math.max(1, Math.round(maxRounds ?? DEFAULT_MAX_ROUNDS))),
      enabled: true,
      ...(autoDeliver ? { autoDeliver: true } : {}),
      templates: templateRefs ?? defaultTemplateRefs(),
      createdAt: now,
      updatedAt: now,
    }
    await store.bindings.put(binding.id, binding)
    const run = await this.startRunFor(store, binding, task)
    return { binding, run }
  }

  /** Resolve template bodies for a new run, falling back to built-ins. */
  private async resolveBodies(refs: { start: string, review: string, rework: string }): Promise<RunRecord['templates']> {
    const store = await this.ready()
    const resolve = (id: string, fallbackKey: string): string =>
      store.templates.get(id)?.body ?? store.templates.get(fallbackKey)?.body ?? ''
    return {
      start: resolve(refs.start, 'builtin-loop-start'),
      review: resolve(refs.review, 'builtin-loop-review'),
      rework: resolve(refs.rework, 'builtin-loop-rework'),
    }
  }

  private async startRunFor(store: TriggerStore, binding: BindingRecord, task: string): Promise<RunRecord> {
    const active = [...store.runs.entries()].some(([, run]) => run.bindingId === binding.id && run.status === 'active')
    if (active) throw new Error('该规则组已有进行中的运行；请先暂停或取消旧运行。')
    const bodies = await this.resolveBodies(binding.templates)
    const run = startRun(binding, bodies, task, `run-${crypto.randomUUID()}`, Date.now())
    await store.runs.put(run.id, run)
    return run
  }

  // ── channel surface ──────────────────────────────────────────────────────

  /** The full snapshot the table editor renders. */
  async snapshot(): Promise<TriggerSnapshot> {
    const store = await this.ready()
    const templates = [...store.templates.entries()].map(([, value]) => value)
    const bindings = [...store.bindings.entries()].map(([, value]) => value)
    const runs = [...store.runs.entries()]
      .map(([, value]) => value)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, SNAPSHOT_RUN_LIMIT)
    const deliveries = [...store.deliveries.entries()]
      .map(([, value]) => value)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SNAPSHOT_DELIVERY_LIMIT)
    return { templates, bindings, runs, deliveries }
  }

  /** Known sessions for the pickers (newest first, bounded). */
  async sessions(): Promise<SessionRow[]> {
    await this.ready()
    const signal = new AbortController().signal
    const list = await this.ctx.sessionController.list({}, signal)
    return list.items
      .map(item => {
        // The title rides the session-summary projection block when the host
        // folds one in; it is display-only, so an absent block degrades to the
        // distinguishable short id the client derives.
        const title = (item.projections?.values as { title?: unknown } | undefined)?.title
        return {
          id: String(item.sessionId),
          updatedAt: item.updatedAt,
          running: item.running,
          ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
          ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
  }

  /** Upsert one template (built-ins keep their row: edits allowed, deletes refused). */
  async saveTemplate(input: { id?: unknown, name: unknown, body: unknown }): Promise<TemplateRecord> {
    const store = await this.ready()
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const body = typeof input.body === 'string' ? input.body : ''
    if (name.length === 0) throw new Error('模板名称不能为空。')
    const now = Date.now()
    const existing = typeof input.id === 'string' && input.id.length > 0 ? store.templates.get(input.id) : undefined
    const record: TemplateRecord = {
      id: existing?.id ?? `tpl-${crypto.randomUUID()}`,
      name,
      body,
      ...(existing?.builtin === true ? { builtin: true } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await store.templates.put(record.id, record)
    return record
  }

  async deleteTemplate(id: string): Promise<void> {
    const store = await this.ready()
    const template = store.templates.get(id)
    if (template === undefined) return
    if (template.builtin === true) throw new Error('内置模板不可删除（可编辑正文）。')
    await store.templates.delete(id)
  }

  /** Upsert one binding; edits never touch in-flight runs (they carry snapshots). */
  async saveBinding(input: {
    id?: unknown
    name?: unknown
    executor: unknown
    parent: unknown
    maxRounds?: unknown
    enabled?: unknown
    autoDeliver?: unknown
    templates?: unknown
  }): Promise<BindingRecord> {
    const store = await this.ready()
    const executor = typeof input.executor === 'string' ? input.executor : ''
    const parent = typeof input.parent === 'string' ? input.parent : ''
    if (executor.length === 0 || parent.length === 0) throw new Error('执行与审核会话都不能为空。')
    if (executor === parent) throw new Error('执行与审核必须是两个不同的会话。')
    const existing = typeof input.id === 'string' && input.id.length > 0 ? store.bindings.get(input.id) : undefined
    const defaults = defaultTemplateRefs()
    const rawRefs = (typeof input.templates === 'object' && input.templates !== null ? input.templates : {}) as Record<string, unknown>
    const pickRef = (key: 'start' | 'review' | 'rework'): string => {
      const raw = rawRefs[key]
      return typeof raw === 'string' && store.templates.get(raw) !== undefined ? raw : defaults[key]
    }
    const refs = { start: pickRef('start'), review: pickRef('review'), rework: pickRef('rework') }
    const autoDeliver = typeof input.autoDeliver === 'boolean' ? input.autoDeliver : (existing?.autoDeliver ?? false)
    const now = Date.now()
    const record: BindingRecord = {
      id: existing?.id ?? `bnd-${crypto.randomUUID()}`,
      name: typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : `循环 ${executor.slice(0, 8)}…`,
      executor,
      parent,
      maxRounds: Math.min(MAX_ROUNDS_LIMIT, Math.max(1, Math.round(typeof input.maxRounds === 'number' ? input.maxRounds : (existing?.maxRounds ?? DEFAULT_MAX_ROUNDS)))),
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true),
      ...(autoDeliver ? { autoDeliver: true } : {}),
      templates: refs,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await store.bindings.put(record.id, record)
    return record
  }

  /** Delete a binding; its non-terminal runs are cancelled first. */
  async deleteBinding(id: string): Promise<void> {
    const store = await this.ready()
    const now = Date.now()
    for (const [runId, run] of store.runs.entries()) {
      if (run.bindingId !== id) continue
      if (run.status === 'completed' || run.status === 'cancelled') continue
      const cancelled = cancelRun(run, now)
      if (cancelled.ok) await store.runs.put(runId, cancelled.run)
    }
    await store.bindings.delete(id)
  }

  /** Start a new run of an existing binding (delivers the start prompt). */
  async startRunFromBinding(bindingId: string, task?: string): Promise<RunRecord> {
    const store = await this.ready()
    const binding = store.bindings.get(bindingId)
    if (binding === undefined) throw new Error('规则组不存在。')
    if (!binding.enabled) throw new Error('规则组已停用；请先启用。')
    const run = await this.startRunFor(store, binding, task?.trim().length ? task!.trim() : binding.name)
    await this.deliver({ runId: run.id, round: 1, to: run.executor, kind: 'start' }, run, undefined)
    return run
  }

  /** Pause / resume / cancel / extend / redeliver one run. */
  async controlRun(
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'extend' | 'redeliver',
    options: { message?: string, newMaxRounds?: number, deliveryId?: string } = {},
  ): Promise<RunRecord> {
    const store = await this.ready()
    const run = store.runs.get(runId)
    if (run === undefined) throw new Error(`运行 ${runId} 不存在。`)
    const now = Date.now()
    if (action === 'redeliver') {
      if (options.deliveryId === undefined) throw new Error('redeliver 需要 deliveryId。')
      const delivery = store.deliveries.get(options.deliveryId)
      if (delivery === undefined || delivery.runId !== runId) throw new Error('投递记录不存在。')
      if (delivery.state === 'sent') return run
      // A redelivery wakes the counterpart, so the run must be in a state
      // that both allows it and will accept the answer: terminal runs are
      // refused outright, and a user/budget pause must be lifted deliberately
      // (resume), not as a side effect of re-sending one prompt.
      if (run.status === 'completed' || run.status === 'cancelled') {
        throw new Error('运行已结束，重投会唤醒对方却没有可推进的循环；如需继续请重新启动一次运行。')
      }
      if (run.status !== 'active' && run.status !== 'paused-error') {
        throw new Error(`运行处于「${statusLabel(run.status)}」状态；请先恢复运行，再重投。`)
      }
      // A delivery is actionable only for the round and side the run is
      // CURRENTLY waiting on: re-sending a stale round's prompt would wake
      // the counterpart with outdated instructions whose verdict could then
      // corrupt the new round (a stale review accepted as this round's).
      const expectedPhase = delivery.kind === 'review'
        ? 'awaiting-review'
        : delivery.kind === 'start' || delivery.kind === 'rework'
          ? 'awaiting-delivery'
          : undefined // notice/resume/nudge are informational; the round alone gates
      if (delivery.round !== run.round || (expectedPhase !== undefined && run.phase !== expectedPhase)) {
        throw new Error(
          `该投递属于第 ${delivery.round} 轮的${kindLabel(delivery.kind)}，当前运行在第 ${run.round} 轮（${phaseLabel(run.phase)}）；过期投递不可重投。`,
        )
      }
      // Resume BEFORE sending: once the prompt lands, the counterpart may
      // answer immediately, and a run still parked by the earlier failure
      // would reject that answer. A re-send that fails again re-parks the
      // run (sendQueued parks active runs), so no window is left open —
      // except nudges, which keep their best-effort semantics everywhere.
      let current = run
      if (run.status === 'paused-error') {
        const resumed = resumeRun(run, {}, now)
        if (!resumed.ok) throw new Error(resumed.message)
        await store.runs.put(runId, resumed.run)
        current = resumed.run
        this.ctx.logger(PACKAGE_NAME).info('run re-activated before redelivery', { runId })
      }
      await this.sendQueued(delivery, undefined, delivery.kind === 'nudge')
      return store.runs.get(runId) ?? current
    }
    if (action === 'pause') {
      const paused = pauseRun(run, now)
      if (!paused.ok) throw new Error(paused.message)
      await store.runs.put(runId, paused.run)
      return paused.run
    }
    if (action === 'cancel') {
      const cancelled = cancelRun(run, now)
      if (!cancelled.ok) throw new Error(cancelled.message)
      await store.runs.put(runId, cancelled.run)
      return cancelled.run
    }
    if (action === 'extend') {
      const target = Math.min(MAX_ROUNDS_LIMIT, Math.max(run.maxRounds + 1, Math.round(options.newMaxRounds ?? run.maxRounds + 1)))
      const extended = extendBudget(run, target, now)
      await store.runs.put(runId, extended)
      // A paused-budget run needs its deferred rework released, not just the number raised.
      if (extended.status === 'paused-budget') {
        return this.controlRun(runId, 'resume', options)
      }
      return extended
    }
    // resume
    const deferredSummary = run.pendingRework?.summary
    const resumed = resumeRun(run, { message: options.message, newMaxRounds: options.newMaxRounds }, now)
    if (!resumed.ok) throw new Error(resumed.message)
    await store.runs.put(runId, resumed.run)
    for (const intent of resumed.intents) {
      const summary = intent.kind === 'rework' ? deferredSummary : options.message
      await this.deliver(intent, resumed.run, summary)
    }
    return resumed.run
  }

  /** Runs touching one session (the header action chip). */
  async runsForSession(sessionId: string): Promise<RunRecord[]> {
    const store = await this.ready()
    return [...store.runs.entries()]
      .map(([, value]) => value)
      .filter(run => run.executor === sessionId || run.parent === sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Shutdown: close the domain (drains queued writes). */
  async shutdown(): Promise<void> {
    await this.store?.close()
    this.store = undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by dsh-triggers; absent when that plugin is not mounted. */
    triggerBindings?: TriggerService
  }
}
