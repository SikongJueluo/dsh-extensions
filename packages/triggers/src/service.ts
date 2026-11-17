/** @module dsh-triggers/service */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import { PACKAGE_NAME, SERVICE_NAME } from './identity.js'
import {
  DEFAULT_MAX_ROUNDS,
  SIGNAL_OUTCOMES,
  isSignalOutcome,
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
import { isRecord } from './record.js'
import { emptyFold, foldEvent, scanTurnEnds, type SessionFold, type TurnEndFact } from './replay.js'
import { openStore, type TriggerStore } from './store.js'

/** Plugin-row configuration. */
export interface TriggerConfig {
  deliverTimeoutMs?: number
}

/** What `bindReviewLoop` (the handoff integration) asks for and gets back. */
export interface BindReviewLoopRequest {
  readonly task: string
  readonly executorSession: string
  readonly parentSession: string
  readonly maxRounds?: number
  readonly deliverStart?: boolean
  readonly autoDeliver?: boolean
}

/** Handoff-facing surface (structural, so handoff needs no type import). */
export interface TriggerBindingsService {
  bindReviewLoop(request: BindReviewLoopRequest): Promise<{ bindingId: string; runId: string }>
}

/** A session row for the client pickers. */
export interface SessionRow {
  readonly id: string
  readonly updatedAt: number
  readonly running: boolean
  readonly cwd?: string
  readonly title?: string
}

const MAX_ROUNDS_LIMIT = 50
const SNAPSHOT_RUN_LIMIT = 50
const SNAPSHOT_DELIVERY_LIMIT = 120

/** Snapshot ordering puts unfinished runs before finished ones, so a long history can never push a live run past {@link SNAPSHOT_RUN_LIMIT}. */
function runSnapshotRank(run: RunRecord): number {
  return run.status === 'active' || run.status.startsWith('paused') ? 0 : 1
}
const AUTO_SUMMARY_LIMIT = 6000

/** Whether a session-log read failed because the host has no such session. Matched by code, not `instanceof`: this plugin resolves its own copy of the query package, so the host's error class is a different identity here. */
function isSessionNotFound(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { code?: unknown }).code === 'SESSION_QUERY_SESSION_NOT_FOUND'
  )
}

/** The full UI snapshot the channel serves. */
export interface TriggerSnapshot {
  readonly templates: readonly TemplateRecord[]
  readonly bindings: readonly BindingRecord[]
  readonly runs: readonly RunRecord[]
  readonly deliveries: readonly DeliveryRecord[]
}

/** The trigger runtime. Constructed once per plugin fiber; every public method awaits the internal readiness promise, so a handoff spawn racing the domain open simply waits. */
export class TriggerService extends Service implements TriggerBindingsService {
  private config: TriggerConfig
  private store: TriggerStore | undefined
  private readyPromise: Promise<void>
  private folds = new Map<string, SessionFold>()
  private bootEvents = new Map<string, { type: string; data: unknown }[]>()
  private booted = false
  private seededSessions = new Set<string>()
  private seedingPromises = new Map<string, Promise<void>>()
  private seedingBuffers = new Map<string, { type: string; data: unknown }[]>()
  private chains = new Map<string, Promise<void>>()
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

  /** Startup recovery, in four steps that never send a message a run's own state has made wrong to send: */
  private async recover(): Promise<void> {
    const store = this.store
    if (store === undefined) return
    await this.replayFromLogs(store)
    this.rebuildProjections(store)
    const drain = async (
      runId: string,
      entry: {
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
    ): Promise<void> => {
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

  private drainable(
    store: TriggerStore,
    runId: string,
    entry: {
      readonly round: number
      readonly kind: DeliveryKind
    },
  ): boolean {
    const run = store.runs.get(runId)
    if (run === undefined) return false
    if (entry.kind === 'notice') return true
    if (run.status !== 'active') return false
    if (entry.kind === 'nudge') return true
    const expectedPhase =
      entry.kind === 'review'
        ? 'awaiting-review'
        : entry.kind === 'start' || entry.kind === 'rework'
          ? 'awaiting-delivery'
          : undefined
    return entry.round === run.round && (expectedPhase === undefined || run.phase === expectedPhase)
  }

  private rebuildProjections(store: TriggerStore): void {
    for (const [, run] of store.runs.entries()) {
      for (const entry of run.outbox ?? []) {
        const projected = store.deliveries.get(entry.id)
        if (projected !== undefined && projected.state === entry.state) continue
        void store.deliveries.put(entry.id, this.project(entry))
      }
    }
  }

  private async readSessionLog(sessionId: string): Promise<readonly SessionEvent[]> {
    try {
      return (await this.ctx.sessionQuery.readSession(SessionId(sessionId))).events
    } catch (failure) {
      if (!isSessionNotFound(failure)) throw failure
      this.ctx.logger(PACKAGE_NAME).info('session has no durable log yet', { sessionId })
      return []
    }
  }

  private async replayFromLogs(store: TriggerStore): Promise<void> {
    const activeIds = [...store.runs.entries()]
      .filter(([, run]) => run.status === 'active')
      .map(([id]) => id)
    if (activeIds.length === 0) return
    const active: RunRecord[] = []
    for (const id of activeIds) {
      const run = store.runs.get(id)
      if (run !== undefined) active.push(run)
    }
    const sessions = new Set<string>()
    for (const run of active) {
      sessions.add(run.executor)
      sessions.add(run.parent)
    }
    type Fact = TurnEndFact & { sessionId: string }
    const timeline: Fact[] = []
    const lastClosedBySession = new Map<string, TurnEndFact[]>()
    for (const sessionId of sessions) {
      const events = await this.readSessionLog(sessionId)
      const { facts, final } = scanTurnEnds(events)
      lastClosedBySession.set(sessionId, facts)
      for (const fact of facts) timeline.push({ ...fact, sessionId })
      this.folds.set(sessionId, final)
      this.seededSessions.add(sessionId)
    }
    for (const runId of activeIds) {
      const current = store.runs.get(runId)
      if (current === undefined || current.consumedTurns !== undefined) continue
      const sideCheckpoint = (side: 'executor' | 'parent', sessionId: string): number => {
        const facts = lastClosedBySession.get(sessionId) ?? []
        const pending = current.pendingSignal
        if (pending === undefined) return facts.at(-1)?.turn ?? 0
        const ownsThisSide = pending.session === undefined || pending.session === sessionId
        if (ownsThisSide && pending.turn <= (facts.at(-1)?.turn ?? 0)) {
          return facts.findLast((fact) => fact.turn < pending.turn)?.turn ?? 0
        }
        return facts.at(-1)?.turn ?? 0
      }
      await store.runs.put(runId, {
        ...current,
        consumedTurns: {
          ...(sideCheckpoint('executor', current.executor) > 0
            ? { executor: sideCheckpoint('executor', current.executor) }
            : {}),
          ...(sideCheckpoint('parent', current.parent) > 0
            ? { parent: sideCheckpoint('parent', current.parent) }
            : {}),
        },
      })
    }
    timeline.sort((a, b) => a.time - b.time)
    for (const fact of timeline) {
      await this.commitTurnEnd(
        fact.sessionId,
        fact.turn,
        fact.reasonKind,
        fact.reply,
        fact.goalActive,
        { time: fact.time },
        store,
      )
    }
    this.ctx.logger(PACKAGE_NAME).info('replayed session logs for active runs', {
      runs: active.length,
      facts: timeline.length,
    })
  }

  private synchronize<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const chained = (this.runChains.get(runId) ?? Promise.resolve()).then(fn, fn)
    const tail = chained.then(
      () => undefined,
      () => undefined,
    )
    this.runChains.set(runId, tail)
    void tail.then(() => {
      if (this.runChains.get(runId) === tail) this.runChains.delete(runId)
      return undefined
    })
    return chained
  }

  private onSessionEvent(
    sessionId: string,
    event: { readonly type: string; readonly data: unknown },
  ): void {
    if (!this.booted) {
      const boot = this.bootEvents.get(sessionId) ?? []
      boot.push(event)
      this.bootEvents.set(sessionId, boot)
      return
    }
    this.dispatchSessionEvent(sessionId, event)
  }

  /** The live-event handler proper - only called with seeded caches. */
  private dispatchSessionEvent(
    sessionId: string,
    event: { readonly type: string; readonly data: unknown },
  ): void {
    const buffer = this.seedingBuffers.get(sessionId)
    if (buffer !== undefined) {
      buffer.push(event)
      return
    }
    if (event.type !== 'turn/end') {
      const fold = this.folds.get(sessionId) ?? emptyFold()
      foldEvent(fold, event)
      this.folds.set(sessionId, fold)
      return
    }
    const data = isRecord(event.data) ? event.data : undefined
    const reason = isRecord(data?.reason) ? data.reason : undefined
    const turn = data?.turn
    const reasonKind = reason?.kind
    if (typeof turn !== 'number' || typeof reasonKind !== 'string') return
    const fold = this.folds.get(sessionId) ?? emptyFold()
    const tracked = fold.lastReply
    const reply = tracked !== undefined && tracked.turn === turn ? tracked : undefined
    const goalActive = fold.goalActive
    foldEvent(fold, event)
    this.folds.set(sessionId, fold)
    const chained = (this.chains.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        await this.commitTurnEnd(sessionId, turn, reasonKind, reply, goalActive)
        return undefined
      })
      .catch((error: unknown) => {
        this.ctx
          .logger(PACKAGE_NAME)
          .warn('turn-end commit failed', { sessionId, turn, error: String(error) })
      })
      .finally(() => {
        if (this.chains.get(sessionId) === chained) this.chains.delete(sessionId)
      })
    this.chains.set(sessionId, chained)
  }

  /** Commit every active run whose pending signal belongs to this session AND turn. Session identity matters: the two sides number their turns independently, so the counterpart ending its own same-numbered turn must never commit (or abort) a signal it did not submit. */
  private async commitTurnEnd(
    sessionId: string,
    turn: number,
    reasonKind: string,
    reply: { readonly turn: number; readonly text: string } | undefined,
    goalActive: boolean,
    cutoff?: { readonly time: number },
    storeOverride?: TriggerStore,
  ): Promise<void> {
    const store = storeOverride ?? (await this.ready())
    const turnSpokenFor = [...store.runs.entries()].some(
      ([, run]) =>
        run.pendingSignal !== undefined &&
        run.pendingSignal.session === sessionId &&
        run.pendingSignal.turn === turn,
    )
    const autoCandidates = turnSpokenFor
      ? []
      : [...store.runs.entries()]
          .filter(
            ([, run]) =>
              run.status === 'active' &&
              run.pendingSignal === undefined &&
              sessionId === run.executor &&
              run.phase === 'awaiting-delivery' &&
              run.autoDeliver === true,
          )
          .map(([id]) => id)
    const context = {
      turnSpokenFor,
      autoWinner: autoCandidates.length === 1 ? autoCandidates[0] : undefined,
      autoAmbiguous: autoCandidates.length > 1,
    }
    const now = Date.now()
    for (const [id] of store.runs.entries()) {
      await this.synchronize(id, () =>
        this.applyTurnEnd(
          store,
          id,
          sessionId,
          turn,
          reasonKind,
          reply,
          goalActive,
          cutoff,
          context,
          now,
        ),
      )
    }
  }

  private async applyTurnEnd(
    store: TriggerStore,
    runId: string,
    sessionId: string,
    turn: number,
    reasonKind: string,
    reply: { readonly turn: number; readonly text: string } | undefined,
    goalActive: boolean,
    cutoff: { readonly time: number } | undefined,
    context: { turnSpokenFor: boolean; autoWinner: string | undefined; autoAmbiguous: boolean },
    now: number,
  ): Promise<void> {
    const run = store.runs.get(runId)
    if (run === undefined) return
    const side =
      run.executor === sessionId ? 'executor' : run.parent === sessionId ? 'parent' : undefined
    if (side === undefined) return
    if (cutoff !== undefined && !(cutoff.time > run.startedAt)) return
    if (turn <= (run.consumedTurns?.[side] ?? 0)) return
    const consumed = { ...run.consumedTurns, [side]: turn }
    if (run.status !== 'active') {
      if (run.status === 'completed' || run.status === 'cancelled') return
      await store.runs.put(runId, { ...run, consumedTurns: consumed })
      return
    }
    if (run.pendingSignal !== undefined) {
      const spokenHere =
        signalBelongsTo(run.pendingSignal, run, sessionId) && run.pendingSignal.turn === turn
      if (!spokenHere) {
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
      const entries = outcome.intents.map((intent) =>
        this.mintEntry(intent, outcome.run, intent.kind === 'start' ? undefined : summary),
      )
      await this.commitTransition(
        store,
        runId,
        { ...outcome.run, consumedTurns: consumed },
        entries,
      )
      for (const entry of entries) void this.deliverEntry(store, entry)
      return
    }
    const checkpoint = async (): Promise<void> => {
      await store.runs.put(runId, { ...run, consumedTurns: consumed })
    }
    if (reasonKind !== 'completed') {
      await checkpoint()
      return
    }
    if (sessionId === run.executor && run.phase === 'awaiting-delivery') {
      if (goalActive) {
        await checkpoint()
        return
      }
      if (run.autoDeliver === true) {
        if (context.turnSpokenFor) {
          await checkpoint()
          return
        }
        if (context.autoAmbiguous) {
          await this.sendDeliverNudge(store, run, runId, now, 'deliver-ambiguous', consumed)
          return
        }
        if (context.autoWinner === runId) {
          const summary = this.autoSummary(reply, turn)
          if (summary.length > 0) {
            const outcome = autoDeliver(run, sessionId, turn, summary, now)
            if (outcome.kind === 'advance') {
              const entries = outcome.intents.map((intent) =>
                this.mintEntry(intent, outcome.run, summary),
              )
              await this.commitTransition(
                store,
                runId,
                { ...outcome.run, consumedTurns: consumed },
                entries,
              )
              for (const entry of entries) void this.deliverEntry(store, entry)
              this.ctx.logger(PACKAGE_NAME).info('executor turn auto-delivered', { runId, turn })
            } else {
              await checkpoint()
            }
            return
          }
          await this.sendDeliverNudge(store, run, runId, now, 'deliver-empty', consumed)
          return
        }
        await checkpoint()
        return
      }
      await this.sendDeliverNudge(store, run, runId, now, 'deliver-missing-signal', consumed)
      return
    }
    if (sessionId === run.parent && run.phase === 'awaiting-review') {
      const reviewSent = [...store.deliveries.entries()].some(
        ([, delivery]) =>
          delivery.runId === runId &&
          delivery.round === run.round &&
          delivery.kind === 'review' &&
          delivery.state === 'sent',
      )
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

  /** The auto-delivery summary of this turn: the tracked LAST assistant message of the turn, trimmed. Empty when the turn had no assistant text at all or its final message was empty/whitespace-only - an intermediate message from an earlier step must never stand in for a missing final reply. */
  private autoSummary(
    reply: { readonly turn: number; readonly text: string } | undefined,
    turn: number,
  ): string {
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
    consumed: { readonly executor?: number; readonly parent?: number },
  ): Promise<void> {
    const nudge = dueNudge(run, 'deliver', now)
    if (!nudge.ok) {
      await store.runs.put(runId, { ...run, consumedTurns: consumed })
      return
    }
    const entry = this.mintEntry(
      nudge.intent,
      nudge.run,
      nudgeLine(nudge.run, line),
      true,
      line === 'deliver-ambiguous',
    )
    await this.commitTransition(store, runId, { ...nudge.run, consumedTurns: consumed }, [entry])
    void this.deliverEntry(store, entry)
    this.ctx.logger(PACKAGE_NAME).info('deliver nudge sent', { runId, round: run.round, line })
  }

  /** Mint one outbox entry: the fully composed prompt (a retry re-sends this verbatim - orchestration rules must never differ between attempts) plus the once-minted `requestId` every retry reuses. */
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

  private async commitTransition(
    store: TriggerStore,
    runId: string,
    next: RunRecord,
    entries: readonly OutboxEntry[],
  ): Promise<void> {
    const merged =
      entries.length === 0 ? next : { ...next, outbox: [...(next.outbox ?? []), ...entries] }
    await store.runs.put(runId, merged)
    for (const entry of entries) {
      await store.deliveries.put(entry.id, this.project(entry))
    }
  }

  /** Drop one entry from a run's outbox (a confirmed send leaves the outbox). */
  private withoutOutboxEntry(run: RunRecord, entryId: string): RunRecord {
    const outbox = run.outbox ?? []
    if (!outbox.some((entry) => entry.id === entryId)) return run
    const rest = outbox.filter((entry) => entry.id !== entryId)
    return rest.length === 0 ? { ...run, outbox: undefined } : { ...run, outbox: rest }
  }

  /** Mark one entry failed in place; rows not in the outbox (legacy) pass through. */
  private withOutboxEntryFailed(run: RunRecord, entryId: string): RunRecord {
    const outbox = run.outbox ?? []
    if (!outbox.some((entry) => entry.id === entryId)) return run
    const failed: OutboxEntry[] = []
    for (const entry of outbox) {
      failed.push(entry.id === entryId ? { ...entry, state: 'failed' as const } : entry)
    }
    return { ...run, outbox: failed }
  }

  private async sendQueued(
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
  ): Promise<boolean> {
    const timeoutMs = this.config.deliverTimeoutMs ?? 120_000
    let error: string | undefined
    try {
      const request: SessionPromptRequest = {
        requestId: brandString<SessionRequestId>(delivery.requestId),
        sessionId: SessionId(delivery.to),
        mode: 'queue',
        content: [{ type: 'text', text: delivery.content }],
      }
      await this.ctx.sessionController.prompt(request, AbortSignal.timeout(timeoutMs))
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    return this.synchronize(delivery.runId, () => this.settleDelivery(store, delivery, error))
  }

  /** Async send of a freshly committed outbox entry: the commit already made the run owe this prompt, so the send is fire-and-forget from the transition's point of view (the outbox row is the durable handoff). A throwing store write here is logged, never unhandled. */
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

  /** Settle one finished send attempt - runs ON the run's serial chain. */
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
          history: [
            ...next.history,
            { at: Date.now(), kind: 'pause', detail: `delivery failed: ${error}` },
          ],
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

  /** `trigger_signal` entry: validate, record the pending signal, wait for the turn. */
  async signal(
    callerSession: string,
    args: { runId: unknown; outcome: unknown; summary: unknown },
  ): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
    const store = await this.ready()
    if (typeof args.runId !== 'string' || args.runId.length === 0)
      return { ok: false, error: 'runId 缺失。' }
    if (!isSignalOutcome(args.outcome)) {
      return { ok: false, error: `outcome 必须是 ${SIGNAL_OUTCOMES.join(' / ')} 之一。` }
    }
    if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
      return { ok: false, error: 'summary 不能为空：写明结论与证据指引。' }
    }
    const runId = args.runId
    const outcome = args.outcome
    const summary = args.summary
    return this.synchronize(runId, () =>
      this.acceptSignal(store, callerSession, { runId, outcome, summary }),
    )
  }

  /** Signal acceptance proper - always invoked on the run's serial chain. */
  private async acceptSignal(
    store: TriggerStore,
    callerSession: string,
    args: { runId: string; outcome: SignalOutcome; summary: string },
  ): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
    const run = store.runs.get(args.runId)
    if (run === undefined) {
      return { ok: false, error: `没有 runId=${args.runId} 的运行；请核对触发器提示中的 runId。` }
    }
    const turn = this.folds.get(callerSession)?.currentTurn
    if (turn === undefined) {
      return {
        ok: false,
        error: '当前回合状态未知（插件可能刚重启）；请在本回合结束后的下一回合重新提交。',
      }
    }
    for (const [, other] of store.runs.entries()) {
      if (other.id === run.id || other.status !== 'active' || other.pendingSignal === undefined)
        continue
      if (other.pendingSignal.session === callerSession && other.pendingSignal.turn === turn) {
        return {
          ok: false,
          error: `本回合已为运行 ${other.id} 提交过信号；一个回合只能推进一个运行，请在下一回合再提交。`,
        }
      }
    }
    const result = submitSignal(
      run,
      callerSession,
      args.outcome,
      args.summary.trim(),
      turn,
      Date.now(),
    )
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

  async bindReviewLoop(
    request: BindReviewLoopRequest,
  ): Promise<{ bindingId: string; runId: string }> {
    if (
      request.executorSession === request.parentSession ||
      request.executorSession.length === 0 ||
      request.parentSession.length === 0
    ) {
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
    templateRefs?: { start: string; review: string; rework: string },
    autoDeliverDefault = false,
    deliverStart = false,
  ): Promise<{ binding: BindingRecord; run: RunRecord }> {
    const store = await this.ready()
    const now = Date.now()
    const binding: BindingRecord = {
      id: `bnd-${crypto.randomUUID()}`,
      name: bindingName?.trim().length ? bindingName.trim() : `循环 · ${task.slice(0, 30)}`,
      executor,
      parent,
      maxRounds: Math.min(
        MAX_ROUNDS_LIMIT,
        Math.max(1, Math.round(maxRounds ?? DEFAULT_MAX_ROUNDS)),
      ),
      enabled: true,
      ...(autoDeliverDefault ? { autoDeliver: true } : {}),
      templates: templateRefs ?? defaultTemplateRefs(),
      createdAt: now,
      updatedAt: now,
    }
    await store.bindings.put(binding.id, binding)
    const run = await this.startRunFor(store, binding, task, deliverStart)
    return { binding, run }
  }

  /** Resolve template bodies for a new run, falling back to built-ins. */
  private async resolveBodies(refs: {
    start: string
    review: string
    rework: string
  }): Promise<RunRecord['templates']> {
    const store = await this.ready()
    const resolve = (id: string, fallbackKey: string): string =>
      store.templates.get(id)?.body ?? store.templates.get(fallbackKey)?.body ?? ''
    return {
      start: resolve(refs.start, 'builtin-loop-start'),
      review: resolve(refs.review, 'builtin-loop-review'),
      rework: resolve(refs.rework, 'builtin-loop-rework'),
    }
  }

  /** Seed the live fold of one session from its durable log. Distinguishes two cache states the old `folds.has` check conflated: */
  private async seedFold(sessionId: string): Promise<void> {
    if (this.seededSessions.has(sessionId)) return
    const inFlight = this.seedingPromises.get(sessionId)
    if (inFlight !== undefined) {
      await inFlight
      return
    }
    const buffer: { type: string; data: unknown }[] = []
    let settle!: () => void
    let fail!: (failure: unknown) => void
    const promise = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    void promise.catch(() => {})
    this.seedingPromises.set(sessionId, promise)
    this.seedingBuffers.set(sessionId, buffer)
    try {
      const events = await this.readSessionLog(sessionId)
      this.folds.set(sessionId, scanTurnEnds(events).final)
      this.seededSessions.add(sessionId)
      settle()
    } catch (failure) {
      fail(failure)
      throw failure
    } finally {
      this.seedingPromises.delete(sessionId)
      this.seedingBuffers.delete(sessionId)
    }
    for (const event of buffer) this.dispatchSessionEvent(sessionId, event)
  }

  private async startRunFor(
    store: TriggerStore,
    binding: BindingRecord,
    task: string,
    deliverStart = false,
  ): Promise<RunRecord> {
    const active = [...store.runs.entries()].some(
      ([, run]) => run.bindingId === binding.id && run.status === 'active',
    )
    if (active) throw new Error('该规则组已有进行中的运行；请先暂停或取消旧运行。')
    await this.seedFold(binding.executor)
    await this.seedFold(binding.parent)
    const bodies = await this.resolveBodies(binding.templates)
    const run = startRun(binding, bodies, task, `run-${crypto.randomUUID()}`, Date.now())
    const seeded = { ...run, consumedTurns: {} }
    const entries = deliverStart
      ? [
          this.mintEntry(
            { runId: run.id, round: 1, to: run.executor, kind: 'start' },
            run,
            undefined,
          ),
        ]
      : []
    await this.commitTransition(store, run.id, seeded, entries)
    for (const entry of entries) await this.deliverEntry(store, entry)
    return store.runs.get(run.id) ?? seeded
  }

  /** The UI snapshot. `sessionId` restricts bindings to the pairs that name the session and runs to the participants snapshotted at their start; deliveries follow the visible runs. Filtering happens BEFORE the caps so one busy session can never push another session's rows out of the response. */
  async snapshot(sessionId?: string): Promise<TriggerSnapshot> {
    const store = await this.ready()
    const scope = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
    const templates = [...store.templates.entries()].map(([, value]) => value)
    const bindings = [...store.bindings.entries()]
      .map(([, value]) => value)
      .filter(
        (binding) => scope === undefined || binding.executor === scope || binding.parent === scope,
      )
    const runs = [...store.runs.entries()]
      .map(([, value]) => value)
      .filter((run) => scope === undefined || run.executor === scope || run.parent === scope)
      .toSorted((a, b) => runSnapshotRank(a) - runSnapshotRank(b) || b.startedAt - a.startedAt)
      .slice(0, SNAPSHOT_RUN_LIMIT)
    const visibleRunIds = new Set(runs.map((run) => run.id))
    const deliveries = [...store.deliveries.entries()]
      .map(([, value]) => value)
      .filter((delivery) => scope === undefined || visibleRunIds.has(delivery.runId))
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .slice(0, SNAPSHOT_DELIVERY_LIMIT)
    return { templates, bindings, runs, deliveries }
  }

  /** Known sessions for the pickers (newest first, bounded). */
  async sessions(): Promise<SessionRow[]> {
    await this.ready()
    const signal = new AbortController().signal
    const list = await this.ctx.sessionController.list({}, signal)
    const rows: SessionRow[] = []
    for (const item of list.items) {
      const title = (item.projections?.values as { title?: unknown } | undefined)?.title
      const row: SessionRow = {
        id: String(item.sessionId),
        updatedAt: item.updatedAt,
        running: item.running,
        ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
      }
      rows.push(row)
    }
    return rows.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
  }

  /** Upsert one template (built-ins keep their row: edits allowed, deletes refused). */
  async saveTemplate(input: {
    id?: unknown
    name: unknown
    body: unknown
  }): Promise<TemplateRecord> {
    const store = await this.ready()
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const body = typeof input.body === 'string' ? input.body : ''
    if (name.length === 0) throw new Error('模板名称不能为空。')
    const now = Date.now()
    const existing =
      typeof input.id === 'string' && input.id.length > 0
        ? store.templates.get(input.id)
        : undefined
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
    const existing =
      typeof input.id === 'string' && input.id.length > 0 ? store.bindings.get(input.id) : undefined
    const defaults = defaultTemplateRefs()
    const rawRefs = isRecord(input.templates) ? input.templates : {}
    const pickRef = (key: 'start' | 'review' | 'rework'): string => {
      const raw = rawRefs[key]
      return typeof raw === 'string' && store.templates.get(raw) !== undefined ? raw : defaults[key]
    }
    const refs = { start: pickRef('start'), review: pickRef('review'), rework: pickRef('rework') }
    const autoDeliverValue =
      typeof input.autoDeliver === 'boolean' ? input.autoDeliver : (existing?.autoDeliver ?? false)
    const now = Date.now()
    const record: BindingRecord = {
      id: existing?.id ?? `bnd-${crypto.randomUUID()}`,
      name:
        typeof input.name === 'string' && input.name.trim().length > 0
          ? input.name.trim()
          : `循环 ${executor.slice(0, 8)}…`,
      executor,
      parent,
      maxRounds: Math.min(
        MAX_ROUNDS_LIMIT,
        Math.max(
          1,
          Math.round(
            typeof input.maxRounds === 'number'
              ? input.maxRounds
              : (existing?.maxRounds ?? DEFAULT_MAX_ROUNDS),
          ),
        ),
      ),
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true),
      ...(autoDeliverValue ? { autoDeliver: true } : {}),
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
        if (
          current === undefined ||
          current.status === 'completed' ||
          current.status === 'cancelled'
        )
          return Promise.resolve()
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
    return this.startRunFor(store, binding, task?.trim().length ? task.trim() : binding.name, true)
  }

  /** Pause / resume / cancel / extend / redeliver one run. */
  async controlRun(
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'extend' | 'redeliver',
    options: { message?: string; newMaxRounds?: number; deliveryId?: string } = {},
  ): Promise<RunRecord> {
    const store = await this.ready()
    if (store.runs.get(runId) === undefined) throw new Error(`运行 ${runId} 不存在。`)
    if (action === 'redeliver') {
      await this.synchronize(runId, () => this.prepareRedelivery(store, runId, options))
      const delivery =
        options.deliveryId === undefined ? undefined : store.deliveries.get(options.deliveryId)
      if (delivery !== undefined && delivery.state !== 'sent') {
        await this.sendQueued(store, delivery)
      }
      const run = store.runs.get(runId)
      if (run === undefined) throw new Error(`运行 ${runId} 不存在。`)
      return run
    }
    return this.synchronize(runId, () => this.controlRunOnChain(store, runId, action, options))
  }

  /** Validate a manual redelivery and lift the error-park - on the run chain. */
  private async prepareRedelivery(
    store: TriggerStore,
    runId: string,
    options: { message?: string; newMaxRounds?: number; deliveryId?: string },
  ): Promise<void> {
    const run = store.runs.get(runId)
    if (run === undefined) throw new Error(`运行 ${runId} 不存在。`)
    if (options.deliveryId === undefined) throw new Error('redeliver 需要 deliveryId。')
    const delivery = store.deliveries.get(options.deliveryId)
    if (delivery === undefined || delivery.runId !== runId) throw new Error('投递记录不存在。')
    if (delivery.state === 'sent') return
    if (run.status === 'completed' || run.status === 'cancelled') {
      throw new Error('运行已结束，重投会唤醒对方却没有可推进的循环；如需继续请重新启动一次运行。')
    }
    if (run.status !== 'active' && run.status !== 'paused-error') {
      throw new Error(`运行处于「${statusLabel(run.status)}」状态；请先恢复运行，再重投。`)
    }
    const expectedPhase =
      delivery.kind === 'review'
        ? 'awaiting-review'
        : delivery.kind === 'start' || delivery.kind === 'rework'
          ? 'awaiting-delivery'
          : undefined
    if (
      delivery.round !== run.round ||
      (expectedPhase !== undefined && run.phase !== expectedPhase)
    ) {
      throw new Error(
        `该投递属于第 ${delivery.round} 轮的${kindLabel(delivery.kind)}，当前运行在第 ${run.round} 轮（${phaseLabel(run.phase)}）；过期投递不可重投。`,
      )
    }
    if (run.status === 'paused-error') {
      await this.seedFold(run.executor)
      await this.seedFold(run.parent)
      const resumed = resumeRun(run, {}, Date.now())
      if (!resumed.ok) throw new Error(resumed.message)
      await store.runs.put(runId, resumed.run)
      this.ctx.logger(PACKAGE_NAME).info('run re-activated before redelivery', { runId })
    }
  }

  /** Control actions proper - always invoked on the run's serial chain. */
  private async controlRunOnChain(
    store: TriggerStore,
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'extend' | 'redeliver',
    options: { message?: string; newMaxRounds?: number; deliveryId?: string },
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
      const target = Math.min(
        MAX_ROUNDS_LIMIT,
        Math.max(run.maxRounds + 1, Math.round(options.newMaxRounds ?? run.maxRounds + 1)),
      )
      const extended = extendBudget(run, target, now)
      await store.runs.put(runId, extended)
      if (extended.status === 'paused-budget') {
        return this.controlRunOnChain(store, runId, 'resume', options)
      }
      return extended
    }
    await this.seedFold(run.executor)
    await this.seedFold(run.parent)
    const deferredSummary = run.pendingRework?.summary
    const resumed = resumeRun(
      run,
      { message: options.message, newMaxRounds: options.newMaxRounds },
      now,
    )
    if (!resumed.ok) throw new Error(resumed.message)
    const entries = resumed.intents.map((intent) =>
      this.mintEntry(
        intent,
        resumed.run,
        intent.kind === 'rework' ? deferredSummary : options.message,
      ),
    )
    await this.commitTransition(store, runId, resumed.run, entries)
    for (const entry of entries) void this.deliverEntry(store, entry)
    return store.runs.get(runId) ?? resumed.run
  }

  /** Runs touching one session, newest first (kept for service callers). */
  async runsForSession(sessionId: string): Promise<RunRecord[]> {
    const store = await this.ready()
    return [...store.runs.entries()]
      .map(([, value]) => value)
      .filter((run) => run.executor === sessionId || run.parent === sessionId)
      .toSorted((a, b) => b.startedAt - a.startedAt)
  }

  /** Shutdown: close the domain (drains queued writes). */
  async shutdown(): Promise<void> {
    await this.store?.close()
    this.store = undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    triggerBindings?: TriggerService
  }
}
