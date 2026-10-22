/**
 * The host orchestrator: one Cordis service (`ctx.triggerBindings`) that owns
 * the loop runtime — signal intake from the tool, turn tracking over
 * `session/event`, atomic commit + outbox delivery over the session
 * controller's queue, crash recovery (durable-log replay + outbox drain), and
 * the CRUD/control surface the browser channel and the handoff integration
 * share.
 *
 * Delivery reliability contract: a transition and every prompt it owes are
 * persisted in ONE run-record write (the transactional outbox lives inside
 * the run record); sends run only after that commit and are idempotent under
 * their once-minted `requestId` (the controller dedupes replays). A failed
 * send marks the outbox entry `failed` (kept for manual redelivery) and parks
 * the run in `paused-error` instead of guessing — nudges are the one
 * exception: they are informational and bounded (once per round per side),
 * so a failed nudge only logs. Startup recovery replays the durable session
 * logs point-in-time (missed turn ends, pending signals, goal state) before
 * draining pending outbox entries.
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
  type DeliveryKind,
  type DeliveryRecord,
  type OutboxEntry,
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
import { emptyFold, foldEvent, scanTurnEnds, type SessionFold, type TurnEndFact } from './replay.js'
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
  /** Live per-session caches (open turn, last reply, goal state) from `session/event`. */
  private folds = new Map<string, SessionFold>()
  /**
   * Events observed live while {@link init} is still replaying the durable
   * logs: recovery must not clobber caches these events already advanced.
   * Collected until {@link booted} flips; empty afterwards.
   */
  private bootEvents = new Map<string, { type: string, data: unknown }[]>()
  /** False until init (store open + recovery replay) has settled. */
  private booted = false
  /**
   * Sessions whose fold has been seeded from a durable log (startup replay
   * or {@link seedFold}). A fold can also exist WITHOUT this marker — some
   * live event created it before any seeding ran — and such a transient
   * fold is exactly why seeding must not key off `folds.has`.
   */
  private seededSessions = new Set<string>()
  /**
   * In-flight seedings, shared: every caller (a second bind of the same
   * session, a resume arming its automation) awaits the SAME promise — an
   * in-flight seed is never mistaken for a completed one, so no run is
   * created against a session whose log baseline has not landed yet.
   */
  private seedingPromises = new Map<string, Promise<void>>()
  /** Live events buffered per session while its seeding read is in flight. */
  private seedingBuffers = new Map<string, { type: string, data: unknown }[]>()
  /** Per-session promise chain keeping turn-end commits serial. */
  private chains = new Map<string, Promise<void>>()
  /**
   * Per-run promise chain: every read-modify-write of ONE run (signal,
   * control, turn-end transition, delivery settlement) queues here, so two
   * concurrent entrants can never compute off the same stale snapshot and
   * have the last put clobber the first (e.g. cancel vs extend).
   */
  private runChains = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: TriggerConfig) {
    super(ctx, SERVICE_NAME)
    this.config = config
    this.readyPromise = this.init()
    ctx.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event))
  }

  private async init(): Promise<void> {
    this.store = await openStore(this.ctx)
    await this.recover()
    // Replay the boot buffer now that the log scan has seeded the caches:
    // every buffered event folds and dispatches in arrival order against the
    // seeded baseline. Synchronous on purpose — no interleaving with new
    // live events (those see `booted` still false and land in the buffer,
    // which the following drain-once clear leaves empty for them).
    const buffered = [...this.bootEvents.entries()]
    this.bootEvents.clear()
    for (const [sessionId, events] of buffered) {
      for (const event of events) this.dispatchSessionEvent(sessionId, event)
    }
    this.booted = true
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
   * Startup recovery, in four steps that never send a message a run's own
   * state has made wrong to send:
   *
   * 1. **Log replay** — for every still-active run, the durable session logs
   *    are re-scanned and turn ends the crashed plugin never handled are
   *    re-derived point-in-time (per-run consumption checkpoints make the
   *    replay exactly-once per turn; already-consumed turns never re-match,
   *    whichever round the run is in by now). This also rebuilds the live
   *    caches (open turn, last reply, goal state).
   * 2. **Projection rebuild** — deliveries-table rows are re-derived from
   *    the authoritative run outbox, healing any write that crashed between
   *    the two tables.
   * 3. **Outbox drain** — still-pending entries re-send under their original
   *    `requestId` (the queue dedupes), gated by the run's CURRENT state:
   *    conversation prompts (start/review/rework/resume) only for an active
   *    run in the matching round/phase; terminal runs keep only notices;
   *    nudges only for active runs. Failed entries wait for manual
   *    redelivery; nudges stay best-effort everywhere.
   * 4. **Legacy rows** — pending deliveries written by pre-outbox builds
   *    (no run carries them) keep their old restart contract, same gating.
   *
   * Runs inside init: the store is handed in, since the send path's own
   * readiness wait would deadlock on the very init calling it.
   */
  private async recover(): Promise<void> {
    const store = this.store
    if (store === undefined) return
    await this.replayFromLogs(store)
    this.rebuildProjections(store)
    const drain = async (runId: string, entry: {
      readonly id: string
      readonly runId: string
      readonly round: number
      readonly to: string
      readonly kind: DeliveryKind
      readonly requestId: string
      readonly content: string
      readonly createdAt: number
      readonly bestEffort?: true
    }): Promise<void> => {
      if (!this.drainable(store, runId, entry)) return
      await this.sendQueued(store, entry)
    }
    const ownedIds = new Set<string>()
    for (const [runId, run] of store.runs.entries()) {
      for (const entry of run.outbox ?? []) {
        ownedIds.add(entry.id)
        if (entry.state !== 'pending') continue
        await drain(runId, entry)
      }
    }
    for (const [, delivery] of store.deliveries.entries()) {
      if (delivery.state !== 'pending' || ownedIds.has(delivery.id)) continue
      await drain(delivery.runId, delivery)
    }
  }

  /**
   * Whether a pending outbox entry may still be auto-drained for its run AS
   * THE RUN STANDS NOW. A cancelled/completed run must not wake a
   * counterpart into a loop that no longer accepts answers — but a notice
   * the transition already committed (pass/needs_user notification) is the
   * promised message and stays deliverable. Paused runs never auto-drain
   * conversation prompts: resuming is the user's call (manual redelivery
   * enforces the same rule). Stale-round prompts would carry outdated
   * instructions, so round and phase must still match.
   */
  private drainable(store: TriggerStore, runId: string, entry: {
    readonly round: number
    readonly kind: DeliveryKind
  }): boolean {
    const run = store.runs.get(runId)
    if (run === undefined) return false
    if (entry.kind === 'notice') return true
    if (run.status !== 'active') return false
    if (entry.kind === 'nudge') return true
    // start/rework expect a delivery; review expects a verdict; resume is a
    // user note into an active loop. All are actionable only in the round
    // and phase the run is CURRENTLY waiting on.
    const expectedPhase = entry.kind === 'review'
      ? 'awaiting-review'
      : entry.kind === 'start' || entry.kind === 'rework'
        ? 'awaiting-delivery'
        : undefined // resume is informational; the round alone gates
    return entry.round === run.round && (expectedPhase === undefined || run.phase === expectedPhase)
  }

  /**
   * Re-derive every deliveries-table row from the authoritative run outbox:
   * missing rows materialize, stale states correct. Heals the windows where
   * a crash between the two tables left the projection diverged (the UI's
   * redeliver button reads the projection, so a diverged failed entry would
   * otherwise be unreachable). Sent/absent entries have no outbox row to
   * re-derive; their projection rows are history and stay as written.
   */
  private rebuildProjections(store: TriggerStore): void {
    for (const [, run] of store.runs.entries()) {
      for (const entry of run.outbox ?? []) {
        const projected = store.deliveries.get(entry.id)
        if (projected !== undefined && projected.state === entry.state) continue
        // Fire-and-forget on the store's own write chain; durability is the
        // domain layer's business and the next restart re-runs this rebuild.
        void store.deliveries.put(entry.id, this.project(entry))
      }
    }
  }

  /**
   * Re-derive missed turn ends from the durable logs of every session an
   * active run listens on. Facts from BOTH sessions merge into one timeline
   * ordered by event time — the two sides' logs interleave causally (a
   * review verdict starts the next executor round), so replaying one whole
   * session before the other would judge turns against the wrong round.
   * Each fact replays only for runs born before it happened AND that have
   * not consumed its turn yet.
   *
   * Records predating the checkpoint (older builds) get it migrated in ONE
   * write per run that merges BOTH sides at once (a per-side write off a
   * stale snapshot would clobber the other side's checkpoint). Migration
   * treats closed history as consumed — EXCEPT the turn a still-pending
   * signal belongs to: that one is left unconsumed so the replay below can
   * settle it from the log (completed commits, abnormal parks, still-open
   * waits). Silently marking it consumed would strand the signal forever.
   */
  private async replayFromLogs(store: TriggerStore): Promise<void> {
    const activeIds = [...store.runs.entries()].filter(([, run]) => run.status === 'active').map(([id]) => id)
    if (activeIds.length === 0) return
    const active = activeIds.map(id => store.runs.get(id)!)
    const sessions = new Set<string>()
    for (const run of active) {
      sessions.add(run.executor)
      sessions.add(run.parent)
    }
    type Fact = TurnEndFact & { sessionId: string }
    const timeline: Fact[] = []
    const lastClosedBySession = new Map<string, TurnEndFact[]>()
    for (const sessionId of sessions) {
      let events: readonly { type: string, time?: unknown, data: unknown }[]
      try {
        const inspection = await this.ctx.sessionController.inspect(
          sessionId as never,
          new AbortController().signal,
        )
        events = inspection.events as readonly { type: string, time?: unknown, data: unknown }[]
      } catch (failure) {
        // Unknown/gone sessions simply have nothing to replay.
        this.ctx.logger(PACKAGE_NAME).info('session log unavailable for replay', {
          sessionId,
          error: String(failure),
        })
        events = []
      }
      const { facts, final } = scanTurnEnds(events)
      lastClosedBySession.set(sessionId, facts)
      for (const fact of facts) timeline.push({ ...fact, sessionId })
      this.folds.set(sessionId, final)
      this.seededSessions.add(sessionId)
    }
    // Checkpoint migration, one merged write per legacy run. This build
    // seeds `consumedTurns` at run creation, so a PRESENT-but-empty object
    // means "consumed nothing yet" and must NOT migrate.
    for (const runId of activeIds) {
      const current = store.runs.get(runId)
      if (current === undefined || current.consumedTurns !== undefined) continue
      const sideCheckpoint = (side: 'executor' | 'parent', sessionId: string): number => {
        const facts = lastClosedBySession.get(sessionId) ?? []
        const pending = current.pendingSignal
        if (pending === undefined) return facts.at(-1)?.turn ?? 0
        // A pending signal's own turn must stay UNCONSUMED so the replay can
        // settle it from the log. (Legacy signals without a session may be
        // committed by either side, so both sides stay below it.)
        const ownsThisSide = pending.session === undefined || pending.session === sessionId
        if (ownsThisSide && pending.turn <= (facts.at(-1)?.turn ?? 0)) {
          return facts.filter(fact => fact.turn < pending.turn).at(-1)?.turn ?? 0
        }
        return facts.at(-1)?.turn ?? 0
      }
      await store.runs.put(runId, {
        ...current,
        consumedTurns: {
          ...(sideCheckpoint('executor', current.executor) > 0 ? { executor: sideCheckpoint('executor', current.executor) } : {}),
          ...(sideCheckpoint('parent', current.parent) > 0 ? { parent: sideCheckpoint('parent', current.parent) } : {}),
        },
      })
    }
    timeline.sort((a, b) => a.time - b.time)
    for (const fact of timeline) {
      await this.commitTurnEnd(fact.sessionId, fact.turn, fact.reasonKind, fact.reply, fact.goalActive, { time: fact.time }, store)
    }
    this.ctx.logger(PACKAGE_NAME).info('replayed session logs for active runs', { runs: active.length, facts: timeline.length })
  }

  /**
   * Serialize one read-modify-write pass over a single run. Every path that
   * GETs a run, computes from it, and PUTs the result queues through here;
   * two concurrent entrants (a cancel racing an extend, a delivery
   * settlement racing a signal) would otherwise both compute off the same
   * stale snapshot and the later put would resurrect the earlier state.
   */
  private synchronize<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const chained = (this.runChains.get(runId) ?? Promise.resolve()).then(fn, fn)
    const tail = chained.then(() => undefined, () => undefined)
    this.runChains.set(runId, tail)
    void tail.then(() => {
      if (this.runChains.get(runId) === tail) this.runChains.delete(runId)
    })
    return chained
  }

  // ── session events ───────────────────────────────────────────────────────

  private onSessionEvent(sessionId: string, event: { readonly type: string, readonly data: unknown }): void {
    if (!this.booted) {
      // During boot: ONLY buffer. The log scan is still seeding the baseline
      // caches; judging a boot-time turn end against a not-yet-seeded (empty)
      // cache would freeze a wrong point-in-time goal state. Buffered events
      // are folded and dispatched in order once seeding has landed.
      const boot = this.bootEvents.get(sessionId) ?? []
      boot.push(event)
      this.bootEvents.set(sessionId, boot)
      return
    }
    this.dispatchSessionEvent(sessionId, event)
  }

  /** The live-event handler proper — only called with seeded caches. */
  private dispatchSessionEvent(sessionId: string, event: { readonly type: string, readonly data: unknown }): void {
    const buffer = this.seedingBuffers.get(sessionId)
    if (buffer !== undefined) {
      // A durable-log seeding read is in flight for this session: buffer the
      // event; the seed dispatches it once, in order, once the read lands
      // (judging it now, against a possibly transient cache, would freeze a
      // wrong point-in-time context).
      buffer.push(event)
      return
    }
    if (event.type !== 'turn/end') {
      // Fold everything else live (turn/start, replies, goal).
      const fold = this.folds.get(sessionId) ?? emptyFold()
      foldEvent(fold, event)
      this.folds.set(sessionId, fold)
      return
    }
    const data = event.data as { turn?: unknown, reason?: { kind?: unknown } } | undefined
    const turn = data?.turn
    const reasonKind = data?.reason?.kind
    if (typeof turn !== 'number' || typeof reasonKind !== 'string') return
    // Snapshot the point-in-time context synchronously: a replayed turn/end
    // must not see (and re-deliver) the same final answer twice, and the goal
    // state as of THIS event decides automation — not whatever comes later.
    const fold = this.folds.get(sessionId) ?? emptyFold()
    const tracked = fold.lastReply
    const reply = tracked !== undefined && tracked.turn === turn ? tracked : undefined
    const goalActive = fold.goalActive
    foldEvent(fold, event)
    this.folds.set(sessionId, fold)
    // Chain per session so a fast next turn can never interleave a commit.
    // No cutoff here: the live feed only carries NEW appends (the host never
    // replays history on it), so every live turn end belongs after any run's
    // birth; replay gating is a recovery-only concern.
    const chained = (this.chains.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        await this.commitTurnEnd(sessionId, turn, reasonKind, reply, goalActive)
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
   * forward on their own: an autoDeliver run submits the executor's final reply
   * as the delivery, and either side's missing conclusion earns one bounded
   * nudge per round. Nothing here touches a turn that ended abnormally — an
   * aborted/blocked/error end is user-visible and never a delivery.
   *
   * `goalActive` is the point-in-time snapshot taken when the event arrived
   * (or re-derived at that log position during replay); `cutoff` gates
   * per-run replay: a run only consumes turn ends that happened strictly
   * after it started, so replaying an old session's log can never adopt
   * pre-binding history as this run's deliveries. Each run's pass is
   * serialized on its run chain and re-reads the run inside the chain.
   */
  private async commitTurnEnd(
    sessionId: string,
    turn: number,
    reasonKind: string,
    reply: { readonly turn: number, readonly text: string } | undefined,
    goalActive: boolean,
    cutoff?: { readonly time: number },
    storeOverride?: TriggerStore,
  ): Promise<void> {
    // Recovery replays run inside init and hands the store in directly:
    // waiting on readiness here would deadlock the very init calling us.
    const store = storeOverride ?? await this.ready()
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
    const context = {
      turnSpokenFor,
      autoWinner: autoCandidates.length === 1 ? autoCandidates[0]! : undefined,
      autoAmbiguous: autoCandidates.length > 1,
    }
    const now = Date.now()
    for (const [id] of store.runs.entries()) {
      await this.synchronize(id, () =>
        this.applyTurnEnd(store, id, sessionId, turn, reasonKind, reply, goalActive, cutoff, context, now))
    }
  }

  /**
   * One run's serialized slice of a turn end. The consumption checkpoint
   * (`consumedTurns`) advances with EVERY consumed turn — advancing,
   * skipping, even while paused — and rides the SAME write as any
   * transition, so a restart replay can never judge an old turn against a
   * newer round (round 1's delivery re-submitted as round 2's).
   */
  private async applyTurnEnd(
    store: TriggerStore,
    runId: string,
    sessionId: string,
    turn: number,
    reasonKind: string,
    reply: { readonly turn: number, readonly text: string } | undefined,
    goalActive: boolean,
    cutoff: { readonly time: number } | undefined,
    context: { turnSpokenFor: boolean, autoWinner: string | undefined, autoAmbiguous: boolean },
    now: number,
  ): Promise<void> {
    const run = store.runs.get(runId)
    if (run === undefined) return
    const side = run.executor === sessionId ? 'executor' : run.parent === sessionId ? 'parent' : undefined
    if (side === undefined) return
    // Replay gating: this run only consumes turn ends from after its birth,
    // and never one it has already consumed (live or in an earlier replay).
    if (cutoff !== undefined && !(cutoff.time > run.startedAt)) return
    if (turn <= (run.consumedTurns?.[side] ?? 0)) return
    const consumed = { ...run.consumedTurns, [side]: turn }
    if (run.status !== 'active') {
      // Terminal runs never replay again; paused ones DO resume, so the turn
      // still counts as consumed — a pause-window turn must not wake up as a
      // fresh delivery after the user resumes.
      if (run.status === 'completed' || run.status === 'cancelled') return
      await store.runs.put(runId, { ...run, consumedTurns: consumed })
      return
    }
    if (run.pendingSignal !== undefined) {
      const spokenHere = signalBelongsTo(run.pendingSignal, run, sessionId) && run.pendingSignal.turn === turn
      if (!spokenHere) {
        // Not this run's signal turn: checkpoint only.
        await store.runs.put(runId, { ...run, consumedTurns: consumed })
        return
      }
      const summary = run.pendingSignal.summary
      const outcome = commitTurnEnd(run, sessionId, turn, reasonKind, now)
      if (outcome.kind === 'ignored') {
        await store.runs.put(runId, { ...run, consumedTurns: consumed })
        return
      }
      if (outcome.kind === 'aborted') {
        await this.commitTransition(store, runId, { ...outcome.run, consumedTurns: consumed }, [])
        this.ctx.logger(PACKAGE_NAME).warn('signal turn ended abnormally; run parked', {
          runId,
          reason: reasonKind,
        })
        return
      }
      const entries = outcome.intents.map(intent =>
        this.mintEntry(intent, outcome.run, intent.kind === 'start' ? undefined : summary))
      await this.commitTransition(store, runId, { ...outcome.run, consumedTurns: consumed }, entries)
      // Sends run OFF the run chain (the queue may re-enter inline); the
      // outbox row is the durable handoff if this process dies first.
      for (const entry of entries) void this.deliverEntry(store, entry)
      return
    }
    // No pending signal: the turn may still drive automation, but every
    // outcome (including "do nothing") checkpoints the consumption.
    const checkpoint = async (): Promise<void> => {
      await store.runs.put(runId, { ...run, consumedTurns: consumed })
    }
    if (reasonKind !== 'completed') {
      await checkpoint()
      return
    }
    if (sessionId === run.executor && run.phase === 'awaiting-delivery') {
      // Mid-goal turns look exactly like finished ones at turn/end; the
      // driver may continue, so hold automation until the goal settles.
      if (goalActive) {
        await checkpoint()
        return
      }
      if (run.autoDeliver === true) {
        // The turn was spent on another run's explicit signal: nothing to
        // interpret here, and no reminder either — the executor already
        // spoke for one loop this turn.
        if (context.turnSpokenFor) {
          await checkpoint()
          return
        }
        // Several auto runs are waiting on this one session: the reply
        // cannot be attributed; ask for an explicit signal per run. The
        // reminder must carry its own instructions — the standing block of
        // an autoDeliver run promises a normal turn end delivers itself,
        // which would cancel out the required recovery path.
        if (context.autoAmbiguous) {
          await this.sendDeliverNudge(store, run, runId, now, 'deliver-ambiguous', consumed)
          return
        }
        if (context.autoWinner === runId) {
          const summary = this.autoSummary(reply, turn)
          if (summary.length > 0) {
            const outcome = autoDeliver(run, sessionId, turn, summary, now)
            if (outcome.kind === 'advance') {
              const entries = outcome.intents.map(intent => this.mintEntry(intent, outcome.run, summary))
              await this.commitTransition(store, runId, { ...outcome.run, consumedTurns: consumed }, entries)
              for (const entry of entries) void this.deliverEntry(store, entry)
              this.ctx.logger(PACKAGE_NAME).info('executor turn auto-delivered', { runId, turn })
            } else {
              await checkpoint()
            }
            return
          }
          // The turn's LAST assistant message carried no deliverable text
          // (empty, whitespace-only, or none at all): never fall back to an
          // earlier intermediate message.
          await this.sendDeliverNudge(store, run, runId, now, 'deliver-empty', consumed)
          return
        }
        // Not the winner and not ambiguous (this run wasn't an eligible
        // candidate for this turn at all): leave it untouched.
        await checkpoint()
        return
      }
      await this.sendDeliverNudge(store, run, runId, now, 'deliver-missing-signal', consumed)
      return
    }
    if (sessionId === run.parent && run.phase === 'awaiting-review') {
      // Only nudge once the review prompt itself has landed; a turn that
      // ended before the delivery was sent never saw the material.
      const reviewSent = [...store.deliveries.entries()]
        .some(([, delivery]) => delivery.runId === runId && delivery.round === run.round
          && delivery.kind === 'review' && delivery.state === 'sent')
      if (!reviewSent || goalActive) {
        await checkpoint()
        return
      }
      const nudge = dueNudge(run, 'review', now)
      if (!nudge.ok) {
        await checkpoint()
        return
      }
      const entry = this.mintEntry(nudge.intent, nudge.run, nudgeLine(nudge.run, 'review'), true)
      await this.commitTransition(store, runId, { ...nudge.run, consumedTurns: consumed }, [entry])
      void this.deliverEntry(store, entry)
      this.ctx.logger(PACKAGE_NAME).info('review nudge sent', { runId, round: run.round })
      return
    }
    await checkpoint()
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
    consumed: { readonly executor?: number, readonly parent?: number },
  ): Promise<void> {
    const nudge = dueNudge(run, 'deliver', now)
    if (!nudge.ok) {
      // Not due (already nudged this round): still checkpoint the turn.
      await store.runs.put(runId, { ...run, consumedTurns: consumed })
      return
    }
    const entry = this.mintEntry(nudge.intent, nudge.run, nudgeLine(nudge.run, line), true, line === 'deliver-ambiguous')
    await this.commitTransition(store, runId, { ...nudge.run, consumedTurns: consumed }, [entry])
    void this.deliverEntry(store, entry)
    this.ctx.logger(PACKAGE_NAME).info('deliver nudge sent', { runId, round: run.round, line })
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  /**
   * Mint one outbox entry: the fully composed prompt (a retry re-sends this
   * verbatim — orchestration rules must never differ between attempts) plus
   * the once-minted `requestId` every retry reuses.
   */
  private mintEntry(
    intent: DeliveryIntent,
    run: RunRecord,
    summary: string | undefined,
    bestEffort = false,
    standalone = false,
  ): OutboxEntry {
    return {
      id: crypto.randomUUID(),
      runId: intent.runId,
      round: intent.round,
      to: intent.to,
      kind: intent.kind,
      requestId: `trg-${crypto.randomUUID()}`,
      state: 'pending',
      content: composeDeliveryPrompt(intent, run, summary, standalone),
      ...(bestEffort ? { bestEffort: true } : {}),
      createdAt: Date.now(),
    }
  }

  /** The deliveries-table projection of an outbox entry (rebuildable UI history). */
  private project(entry: OutboxEntry, overrides?: Partial<DeliveryRecord>): DeliveryRecord {
    return {
      id: entry.id,
      runId: entry.runId,
      round: entry.round,
      to: entry.to,
      kind: entry.kind,
      requestId: entry.requestId,
      state: entry.state === 'failed' ? 'failed' : 'pending',
      content: entry.content,
      createdAt: entry.createdAt,
      ...overrides,
    }
  }

  /**
   * THE atomic transition commit: the run's next state and every prompt it
   * owes go to storage in ONE record write — before it neither exists, after
   * it both do, so a crash can never split a transition from its deliveries.
   * The deliveries-table rows are a rebuildable projection written next; the
   * sends themselves are the caller's business ({@link deliverEntry}): a send
   * must never run INSIDE the run's serial chain, because the queue may call
   * back into the service (an inline answer signaling mid-send) and would
   * deadlock on its own chain.
   */
  private async commitTransition(
    store: TriggerStore,
    runId: string,
    next: RunRecord,
    entries: readonly OutboxEntry[],
  ): Promise<void> {
    const merged = entries.length === 0
      ? next
      : { ...next, outbox: [...(next.outbox ?? []), ...entries] }
    await store.runs.put(runId, merged)
    for (const entry of entries) {
      await store.deliveries.put(entry.id, this.project(entry))
    }
  }

  /** Drop one entry from a run's outbox (a confirmed send leaves the outbox). */
  private withoutOutboxEntry(run: RunRecord, entryId: string): RunRecord {
    const outbox = run.outbox ?? []
    if (!outbox.some(entry => entry.id === entryId)) return run
    const rest = outbox.filter(entry => entry.id !== entryId)
    return rest.length === 0 ? { ...run, outbox: undefined } : { ...run, outbox: rest }
  }

  /** Mark one entry failed in place; rows not in the outbox (legacy) pass through. */
  private withOutboxEntryFailed(run: RunRecord, entryId: string): RunRecord {
    const outbox = run.outbox ?? []
    if (!outbox.some(entry => entry.id === entryId)) return run
    return { ...run, outbox: outbox.map(entry => entry.id === entryId ? { ...entry, state: 'failed' as const } : entry) }
  }

  /**
   * One idempotent send for a persisted delivery — an outbox entry or a
   * deliveries-table projection row (legacy/manual redelivery). The network
   * attempt runs OFF the run's serial chain (the queue may re-enter the
   * service inline); the settlement — projection first, outbox/run second —
   * runs ON the chain against the latest committed state. Success confirms:
   * the entry leaves the outbox and the projection turns `sent`. Failure
   * parks the entry as `failed` (kept in the outbox for manual redelivery)
   * and — unless best-effort (nudges) — parks the run itself: a delivery the
   * queue refused leaves the run's state undecidable, and guessing is worse
   * than waiting for the user. The abort signal bounds the wait; a timed-out
   * admission is treated as failed and parked (a later redeliver reuses the
   * same requestId).
   */
  private async sendQueued(store: TriggerStore, delivery: {
    readonly id: string
    readonly runId: string
    readonly round: number
    readonly to: string
    readonly kind: DeliveryKind
    readonly requestId: string
    readonly content: string
    readonly createdAt: number
    readonly bestEffort?: true
  }): Promise<boolean> {
    const timeoutMs = this.config.deliverTimeoutMs ?? 120_000
    let error: string | undefined
    try {
      const request: SessionPromptRequest = {
        requestId: delivery.requestId as SessionRequestId,
        sessionId: delivery.to as SessionPromptRequest['sessionId'],
        mode: 'queue',
        content: [{ type: 'text', text: delivery.content }],
      }
      await this.ctx.sessionController.prompt(request, AbortSignal.timeout(timeoutMs))
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    return this.synchronize(delivery.runId, () => this.settleDelivery(store, delivery, error))
  }

  /**
   * Async send of a freshly committed outbox entry: the commit already made
   * the run owe this prompt, so the send is fire-and-forget from the
   * transition's point of view (the outbox row is the durable handoff). A
   * throwing store write here is logged, never unhandled.
   */
  private async deliverEntry(store: TriggerStore, entry: OutboxEntry): Promise<boolean> {
    try {
      return await this.sendQueued(store, entry)
    } catch (failure) {
      this.ctx.logger(PACKAGE_NAME).warn('outbox send crashed', {
        deliveryId: entry.id,
        runId: entry.runId,
        error: String(failure),
      })
      return false
    }
  }

  /** Settle one finished send attempt — runs ON the run's serial chain. */
  private async settleDelivery(
    store: TriggerStore,
    delivery: {
      readonly id: string
      readonly runId: string
      readonly round: number
      readonly to: string
      readonly kind: DeliveryKind
      readonly requestId: string
      readonly content: string
      readonly createdAt: number
      readonly bestEffort?: true
    },
    error: string | undefined,
  ): Promise<boolean> {
    const bestEffort = delivery.bestEffort === true || delivery.kind === 'nudge'
    const run = store.runs.get(delivery.runId)
    if (error === undefined) {
      // Projection FIRST, authority second: a crash between the two leaves a
      // `sent` projection with the entry still in the outbox — the restart
      // drain re-sends it, the queue dedupes, and the outbox clears. The
      // reverse order could strand a pending projection with no outbox row
      // (it would look like a legacy row forever).
      await store.deliveries.put(delivery.id, {
        id: delivery.id,
        runId: delivery.runId,
        round: delivery.round,
        to: delivery.to,
        kind: delivery.kind,
        requestId: delivery.requestId,
        state: 'sent',
        content: delivery.content,
        createdAt: delivery.createdAt,
        sentAt: Date.now(),
      })
      if (run !== undefined) await store.runs.put(run.id, this.withoutOutboxEntry(run, delivery.id))
      return true
    }
    // Same order for failures: the projection turns failed while the
    // authority (outbox entry, still pending from its own point of view)
    // settles right after; either crash side heals on restart (projection
    // rebuild from the outbox, or a pending re-drain that dedupes).
    await store.deliveries.put(delivery.id, {
      id: delivery.id,
      runId: delivery.runId,
      round: delivery.round,
      to: delivery.to,
      kind: delivery.kind,
      requestId: delivery.requestId,
      state: 'failed',
      content: delivery.content,
      createdAt: delivery.createdAt,
      error,
    })
    if (run !== undefined) {
      let next = this.withOutboxEntryFailed(run, delivery.id)
      if (!bestEffort && next.status === 'active') {
        next = {
          ...next,
          status: 'paused-error',
          endNote: `投递失败（${delivery.kind} → ${delivery.to}）：${error}`,
          history: [...next.history, { at: Date.now(), kind: 'pause', detail: `delivery failed: ${error}` }],
        }
      }
      await store.runs.put(run.id, next)
    }
    if (bestEffort) {
      this.ctx.logger(PACKAGE_NAME).warn('nudge delivery failed (best effort; run untouched)', {
        deliveryId: delivery.id,
        runId: delivery.runId,
        error,
      })
      return false
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
    // The read-modify-write half runs on the run's serial chain: a signal
    // racing a cancel/transition must see the run's latest committed state.
    return this.synchronize(args.runId, () => this.acceptSignal(store, callerSession, args))
  }

  /** Signal acceptance proper — always invoked on the run's serial chain. */
  private async acceptSignal(
    store: TriggerStore,
    callerSession: string,
    args: { runId: unknown, outcome: unknown, summary: unknown },
  ): Promise<{ ok: true, note: string } | { ok: false, error: string }> {
    const run = store.runs.get(args.runId as string)
    if (run === undefined) {
      return { ok: false, error: `没有 runId=${args.runId} 的运行；请核对触发器提示中的 runId。` }
    }
    const turn = this.folds.get(callerSession)?.currentTurn
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
    const result = submitSignal(run, callerSession, args.outcome as SignalOutcome, (args.summary as string).trim(), turn, Date.now())
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
      request.deliverStart === true,
    )
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
    deliverStart = false,
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
    const run = await this.startRunFor(store, binding, task, deliverStart)
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

  /**
   * Seed the live fold of one session from its durable log. Distinguishes
   * two cache states the old `folds.has` check conflated:
   *
   * - SEEDED: a fold derived from the durable log (this method, or the
   *   startup replay) — never re-seeded, a repeat would overwrite live
   *   progress with a stale snapshot;
   * - TRANSIENT: a fold some live event created before any seeding ran —
   *   it says nothing about the log's history (a cold goal would stay
   *   invisible), so seeding is still required.
   *
   * Live events arriving WHILE the log read is in flight are buffered and
   * folded over the log baseline in arrival order once it lands, so the
   * merge loses no realtime progress (an open turn, a newer reply) and
   * judges no event twice.
   */
  private async seedFold(sessionId: string): Promise<void> {
    if (this.seededSessions.has(sessionId)) return
    const inFlight = this.seedingPromises.get(sessionId)
    if (inFlight !== undefined) {
      // Another seeding of this session is already running: WAIT for it —
      // returning early would let a second bind create its run against a
      // baseline that has not landed.
      await inFlight
      return
    }
    const buffer: { type: string, data: unknown }[] = []
    let settle!: () => void
    const promise = new Promise<void>(resolve => {
      settle = resolve
    })
    this.seedingPromises.set(sessionId, promise)
    this.seedingBuffers.set(sessionId, buffer)
    try {
      let events: readonly { type: string, data: unknown }[]
      try {
        const inspection = await this.ctx.sessionController.inspect(
          sessionId as never,
          new AbortController().signal,
        )
        events = inspection.events as readonly { type: string, data: unknown }[]
      } catch {
        // Unknown session: an empty fold is the honest baseline.
        events = []
      }
      // The durable baseline lands AS SCANNED — buffered events are NOT
      // pre-folded into it. Pre-folding would let an early buffered turn
      // end see a later buffered goal state; instead each buffered event is
      // dispatched once below, in arrival order, snapshotting its own
      // point-in-time context off this baseline.
      this.folds.set(sessionId, scanTurnEnds(events).final)
      this.seededSessions.add(sessionId)
    } finally {
      this.seedingPromises.delete(sessionId)
      this.seedingBuffers.delete(sessionId)
      settle()
    }
    // Unbuffered now: dispatch each buffered event exactly once, in order.
    // Turn ends snapshot their point-in-time goal/reply against the baseline
    // plus everything dispatched before them, and queue on the session
    // chain. Synchronous loop with no awaits: new live events cannot
    // interleave; awaiters of the shared promise resume after this drain.
    for (const event of buffer) this.dispatchSessionEvent(sessionId, event)
  }

  private async startRunFor(store: TriggerStore, binding: BindingRecord, task: string, deliverStart = false): Promise<RunRecord> {
    const active = [...store.runs.entries()].some(([, run]) => run.bindingId === binding.id && run.status === 'active')
    if (active) throw new Error('该规则组已有进行中的运行；请先暂停或取消旧运行。')
    // Seed the live caches for both bound sessions before the run exists: a
    // goal that has been active in a session's log since before this plugin
    // (re)started would otherwise be invisible to the run's first turn end,
    // which would then deliver mid-goal. Startup replay only seeds sessions
    // of runs that were already active at boot; a fresh bind covers its own.
    await this.seedFold(binding.executor)
    await this.seedFold(binding.parent)
    const bodies = await this.resolveBodies(binding.templates)
    const run = startRun(binding, bodies, task, `run-${crypto.randomUUID()}`, Date.now())
    // The checkpoint starts PRESENT but empty: records created by this build
    // are never mistaken for pre-checkpoint legacy rows (whose replay
    // migration would mark closed history as consumed).
    const seeded = { ...run, consumedTurns: {} }
    // The start prompt (when owed) is committed WITH the run creation in the
    // same single write: a crash right after it can strand neither the run
    // without its opening prompt nor the prompt without its run.
    const entries = deliverStart
      ? [this.mintEntry({ runId: run.id, round: 1, to: run.executor, kind: 'start' }, run, undefined)]
      : []
    await this.commitTransition(store, run.id, seeded, entries)
    for (const entry of entries) await this.deliverEntry(store, entry)
    return store.runs.get(run.id) ?? seeded
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
      await this.synchronize(runId, () => {
        const current = store.runs.get(runId)
        if (current === undefined || current.status === 'completed' || current.status === 'cancelled') return Promise.resolve()
        const cancelled = cancelRun(current, now)
        if (cancelled.ok) return store.runs.put(runId, cancelled.run)
        return Promise.resolve()
      })
    }
    await store.bindings.delete(id)
  }

  /** Start a new run of an existing binding (delivers the start prompt). */
  async startRunFromBinding(bindingId: string, task?: string): Promise<RunRecord> {
    const store = await this.ready()
    const binding = store.bindings.get(bindingId)
    if (binding === undefined) throw new Error('规则组不存在。')
    if (!binding.enabled) throw new Error('规则组已停用；请先启用。')
    return this.startRunFor(store, binding, task?.trim().length ? task!.trim() : binding.name, true)
  }

  /** Pause / resume / cancel / extend / redeliver one run. */
  async controlRun(
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'extend' | 'redeliver',
    options: { message?: string, newMaxRounds?: number, deliveryId?: string } = {},
  ): Promise<RunRecord> {
    const store = await this.ready()
    if (store.runs.get(runId) === undefined) throw new Error(`运行 ${runId} 不存在。`)
    // Every action is a read-modify-write of this run: serialize on the run
    // chain so concurrent controls (cancel vs extend, redeliver vs signal)
    // each compute from the latest committed state, never a shared stale
    // snapshot whose later put resurrects the earlier one.
    if (action === 'redeliver') {
      // Prepare ON the chain (validate + resume), send OFF it: the queue may
      // re-enter the service inline (an immediate answer signaling mid-send)
      // and must not deadlock on this run's own chain.
      await this.synchronize(runId, () => this.prepareRedelivery(store, runId, options))
      const delivery = options.deliveryId === undefined ? undefined : store.deliveries.get(options.deliveryId)
      if (delivery !== undefined && delivery.state !== 'sent') {
        await this.sendQueued(store, delivery)
      }
      return store.runs.get(runId)!
    }
    return this.synchronize(runId, () => this.controlRunOnChain(store, runId, action, options))
  }

  /** Validate a manual redelivery and lift the error-park — on the run chain. */
  private async prepareRedelivery(
    store: TriggerStore,
    runId: string,
    options: { message?: string, newMaxRounds?: number, deliveryId?: string },
  ): Promise<void> {
    const run = store.runs.get(runId)
    if (run === undefined) throw new Error(`运行 ${runId} 不存在。`)
    if (options.deliveryId === undefined) throw new Error('redeliver 需要 deliveryId。')
    const delivery = store.deliveries.get(options.deliveryId)
    if (delivery === undefined || delivery.runId !== runId) throw new Error('投递记录不存在。')
    if (delivery.state === 'sent') return
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
    // run (settleDelivery parks active runs), so no window is left open —
    // except nudges, which keep their best-effort semantics everywhere.
    if (run.status === 'paused-error') {
      await this.seedFold(run.executor)
      await this.seedFold(run.parent)
      const resumed = resumeRun(run, {}, Date.now())
      if (!resumed.ok) throw new Error(resumed.message)
      await store.runs.put(runId, resumed.run)
      this.ctx.logger(PACKAGE_NAME).info('run re-activated before redelivery', { runId })
    }
  }

  /** Control actions proper — always invoked on the run's serial chain. */
  private async controlRunOnChain(
    store: TriggerStore,
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'extend' | 'redeliver',
    options: { message?: string, newMaxRounds?: number, deliveryId?: string },
  ): Promise<RunRecord> {
    const run = store.runs.get(runId)
    if (run === undefined) throw new Error(`运行 ${runId} 不存在。`)
    const now = Date.now()
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
        return this.controlRunOnChain(store, runId, 'resume', options)
      }
      return extended
    }
    // resume — re-arm the sessions' caches BEFORE reviving the run: a paused
    // run's sessions were never seeded (startup replay only covers active
    // runs), and seeding inside the run chain orders buffered turn ends
    // BEHIND the revival, so the first post-resume turn is judged with the
    // durable baseline (a cold goal since the pause included).
    await this.seedFold(run.executor)
    await this.seedFold(run.parent)
    const deferredSummary = run.pendingRework?.summary
    const resumed = resumeRun(run, { message: options.message, newMaxRounds: options.newMaxRounds }, now)
    if (!resumed.ok) throw new Error(resumed.message)
    const entries = resumed.intents.map(intent =>
      this.mintEntry(intent, resumed.run, intent.kind === 'rework' ? deferredSummary : options.message))
    await this.commitTransition(store, runId, resumed.run, entries)
    for (const entry of entries) void this.deliverEntry(store, entry)
    return store.runs.get(runId) ?? resumed.run
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
