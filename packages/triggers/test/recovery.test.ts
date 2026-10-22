/**
 * Crash-boundary tests for the atomic transition commit: a run's state
 * advance, the prompts it owes (transactional outbox), and replay/recovery
 * against the durable session log. Everything runs over a fake host whose
 * queue implements the REAL host contract — a repeated requestId is accepted
 * again without inserting a second message — because that dedupe is what
 * makes outbox redelivery safe.
 *
 * Crash points drilled (each between two durable effects, never inside one):
 *
 * - before the commit write: the old state survives whole; the durable log
 *   still carries the turn end, so restart replay re-does the transition;
 * - after the commit write, before the send: the outbox row exists; restart
 *   re-sends it under the same requestId;
 * - after the send, before the sent-mark: restart re-sends; the queue dedupe
 *   keeps the counterpart's log single-copy.
 *
 * @module dsh-triggers/recovery.test
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { TriggerService } from '../src/service.js'
import type { OutboxEntry, RunRecord } from '../src/model.js'

/** Durable event rows exactly as `sessionController.inspect` returns them. */
interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

interface FakePromptCall {
  requestId: string
  sessionId: string
  mode: string
  text: string
}

/** Sentinel a hook throws to simulate the process dying at that point. */
class Crash extends Error {
  constructor() { super('simulated crash') }
}

/**
 * Minimal host surface. Differences from the plain service-test fake, both
 * deliberate: `inspect` serves a per-session durable log, and `prompt`
 * dedupes requestIds the way the session controller's queue actually does.
 */
function createFakeHost() {
  const tables = {
    templates: new Map<string, unknown>(),
    bindings: new Map<string, unknown>(),
    runs: new Map<string, unknown>(),
    deliveries: new Map<string, unknown>(),
  }
  const logs = new Map<string, LogEvent[]>()
  const listeners = new Map<string, Array<(session: { id: string }, event: unknown) => void>>()
  const prompts: FakePromptCall[] = []
  /** RequestIds the queue already accepted (host dedupe state). */
  const admitted = new Set<string>()
  const queue = { fail: false }
  /**
   * Host-realism switches: `slowPuts` delays run-record publication by a
   * tick (the domain layer publishes after durability, so a concurrent get
   * sees the old value); `inspectGate` freezes the inspect snapshot before
   * awaiting (events landing during the read must come from the boot buffer).
   */
  const slowPuts = { runs: false }
  let inspectGate: Promise<void> | undefined
  /** Fault injection: called around the interesting durable effects. */
  const hooks: {
    beforeRunsPut?: () => void
    afterRunsPut?: () => void
    afterPrompt?: (requestId: string) => void
  } = {}

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  const tableFor = (name: keyof typeof tables) => ({
    get: (key: string) => tables[name].get(key),
    entries: () => tables[name].entries() as IterableIterator<[string, never]>,
    keys: () => tables[name].keys() as IterableIterator<string>,
    get size() { return tables[name].size },
    put: async (key: string, value: unknown) => {
      if (name === 'runs') {
        hooks.beforeRunsPut?.()
        if (slowPuts.runs) {
          await sleep(5)
          tables[name].set(key, value)
          hooks.afterRunsPut?.()
          return
        }
        tables[name].set(key, value)
        hooks.afterRunsPut?.()
        return
      }
      tables[name].set(key, value)
    },
    delete: async (key: string) => tables[name].delete(key),
  })

  const ctx = {
    reflect: { provide: () => {} },
    on: (event: string, listener: (session: { id: string }, event: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    logger: () => ({ info: () => {}, warn: () => {} }),
    storageDomain: {
      open: async () => ({
        table: (name: string) => tableFor(name as keyof typeof tables),
        close: async () => {},
      }),
    },
    sessionController: {
      prompt: async (request: { requestId: string, sessionId: string, mode: string, content: { type: string, text: string }[] }) => {
        if (queue.fail) throw new Error('queue refused')
        const text = request.content[0]?.text ?? ''
        // Host contract: an already-admitted requestId returns the original
        // acceptance WITHOUT inserting another message.
        if (!admitted.has(request.requestId)) {
          admitted.add(request.requestId)
          prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text })
        }
        hooks.afterPrompt?.(request.requestId)
        return { accepted: true as const }
      },
      list: async () => ({ items: [] }),
      inspect: async (sessionId: string) => {
        // Host realism: the snapshot freezes at read start; events appended
        // while the read is in flight arrive only through the live feed.
        const frozen = [...(logs.get(sessionId) ?? [])]
        if (inspectGate !== undefined) await inspectGate
        return { events: frozen }
      },
    },
    tools: { register: () => () => {} },
  }

  /** Append to the durable log WITHOUT notifying live listeners (events the crashed plugin never saw). */
  const log = (sessionId: string, type: string, data: unknown, time = Date.now() + 1): LogEvent => {
    const rows = logs.get(sessionId) ?? []
    const event: LogEvent = { type, seq: rows.length, time, data }
    rows.push(event)
    logs.set(sessionId, rows)
    return event
  }
  const emit = (sessionId: string, event: { type: string, data: unknown }): void => {
    log(sessionId, event.type, event.data)
    for (const listener of listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 5))
  }
  /** A fresh plugin instance over the SAME tables/logs: a restart. Kills the old listeners. */
  const service = (): TriggerService => {
    listeners.set('session/event', [])
    return new TriggerService(ctx as never, {})
  }
  const run = (runId: string): RunRecord | undefined => tables.runs.get(runId) as RunRecord | undefined
  const outboxOf = (runId: string): readonly OutboxEntry[] => run(runId)?.outbox ?? []
  const setInspectGate = (gate: Promise<void> | undefined): void => {
    inspectGate = gate
  }
  return { tables, logs, prompts, queue, hooks, slowPuts, admitted, log, emit, flush, service, run, outboxOf, setInspectGate }
}

const EXECUTOR = 'sess-exec'
const PARENT = 'sess-parent'

describe('atomic commit: state advance and owed prompt are one write', () => {
  it('a crash after the commit write leaves the review delivery in the outbox; restart re-sends it under the same requestId', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })

    // Crash the moment the transition write lands — before the send.
    host.hooks.afterRunsPut = () => {
      host.hooks.afterRunsPut = undefined
      throw new Crash()
    }
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()

    // The run advanced AND the owed prompt exists — never one without the other.
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
    const owed = host.outboxOf(bound.runId)
    expect(owed).toHaveLength(1)
    expect(owed[0]!.kind).toBe('review')
    expect(owed[0]!.state).toBe('pending')
    expect(host.prompts).toHaveLength(0) // nothing was sent

    // Restart: the outbox row is re-sent under its original requestId.
    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.requestId).toBe(owed[0]!.requestId)
    expect(host.prompts[0]!.sessionId).toBe(PARENT)
    expect(host.prompts[0]!.text).toContain('runId=' + bound.runId)
    // Confirmed send leaves the outbox and marks the projection row sent.
    expect(host.outboxOf(bound.runId)).toHaveLength(0)
    const projected = [...host.tables.deliveries.values()].find(d => (d as { id: string }).id === owed[0]!.id) as { state: string }
    expect(projected.state).toBe('sent')
  })

  it('a crash BEFORE the commit write keeps the old state whole; restart replay re-does the transition from the log', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })

    host.hooks.beforeRunsPut = () => {
      host.hooks.beforeRunsPut = undefined
      throw new Crash()
    }
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()

    // Halfway state: nothing advanced, nothing owed, nothing sent.
    const parked = host.run(bound.runId)!
    expect(parked.phase).toBe('awaiting-delivery')
    expect(parked.pendingSignal).toBeDefined()
    expect(host.outboxOf(bound.runId)).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)

    // The turn end IS in the durable log: restart replay re-commits it.
    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.sessionId).toBe(PARENT)
    expect(host.prompts[0]!.text).toContain('runId=' + bound.runId)
  })

  it('a crash after the send but before the sent-mark re-sends on restart; the queue dedupe keeps one copy', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    // run writes: #1 the transition commit, #2 the sent-mark. Die before #2.
    let runWrites = 0
    host.hooks.beforeRunsPut = () => {
      runWrites += 1
      if (runWrites === 2) {
        host.hooks.beforeRunsPut = undefined
        throw new Crash()
      }
    }
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    // Message admitted, but the outbox row was never cleared.
    expect(host.prompts).toHaveLength(1)
    expect(host.outboxOf(bound.runId)).toHaveLength(1)

    const svc2 = host.service()
    await host.flush()
    void svc2
    // Same requestId re-sent, queue deduped: still exactly one queued copy.
    expect(host.prompts).toHaveLength(1)
    expect(host.outboxOf(bound.runId)).toHaveLength(0)
    const projected = [...host.tables.deliveries.values()].find(d => (d as { kind: string }).kind === 'review') as { state: string }
    expect(projected.state).toBe('sent')
  })

  it('a start prompt crashed before sending is owed in the run outbox and re-sent on restart', async () => {
    const host = createFakeHost()
    const svc = host.service()
    void svc
    // The start delivery is committed WITH the run creation in one write.
    host.hooks.afterRunsPut = () => {
      host.hooks.afterRunsPut = undefined
      throw new Crash()
    }
    // The process dies inside the bind call: the caller never gets an answer,
    // but the single write already landed (state + owed start prompt).
    await expect(svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT, deliverStart: true }))
      .rejects.toThrow('simulated crash')
    const runId = [...host.tables.runs.keys()].at(-1)!
    expect(host.outboxOf(runId)).toHaveLength(1)
    expect(host.outboxOf(runId)[0]!.kind).toBe('start')
    expect(host.prompts).toHaveLength(0)

    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.sessionId).toBe(EXECUTOR)
    expect(host.prompts[0]!.text).toContain('runId=' + runId)
    expect(host.outboxOf(runId)).toHaveLength(0)
  })
})

describe('restart replay against the durable session log', () => {
  it('a turn end the plugin never saw (already in the log) auto-delivers after restart', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc
    // The executor worked and finished — logged, but the plugin crashed before
    // the event arrived (never emitted to a listener).
    host.log(EXECUTOR, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '日志里完成的交付' }] } })
    host.log(EXECUTOR, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.sessionId).toBe(PARENT)
    expect(host.prompts[0]!.text).toContain('日志里完成的交付')
  })

  it('completed turns from BEFORE the binding existed are never mistaken for deliveries', async () => {
    const host = createFakeHost()
    // An OLD session with history: a finished round long before any run.
    host.log(EXECUTOR, 'assistant/message', { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '绑定前的旧交付' }] } }, Date.now() - 60_000)
    host.log(EXECUTOR, 'turn/end', { turn: 9, reason: { kind: 'completed' } }, Date.now() - 50_000)

    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc
    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.run(bound.runId)!.phase).toBe('awaiting-delivery')
    expect(host.prompts).toHaveLength(0)
  })

  it('a pending signal whose completed turn end is in the log commits after restart instead of parking', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '显式交付' })
    // The turn ended completed while the plugin was down; only the log knows.
    host.log(EXECUTOR, 'turn/end', { turn: 2, reason: { kind: 'completed' } })

    const svc2 = host.service()
    await host.flush()
    void svc2
    const run = host.run(bound.runId)!
    expect(run.phase).toBe('awaiting-review')
    expect(run.pendingSignal).toBeUndefined()
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.text).toContain('显式交付')
  })

  it('a pending signal whose turn ended abnormally parks after restart; a turn still open keeps waiting', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const aborted = await svc.bindReviewLoop({ task: 'a', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 3 } })
    await svc.signal(EXECUTOR, { runId: aborted.runId, outcome: 'deliver', summary: 's' })
    host.log(EXECUTOR, 'turn/end', { turn: 3, reason: { kind: 'aborted' } })

    const stillOpen = await svc.bindReviewLoop({ task: 'b', executorSession: 'sess-exec-2', parentSession: 'sess-parent-2' })
    host.emit('sess-exec-2', { type: 'turn/start', data: { turn: 1 } })
    await svc.signal('sess-exec-2', { runId: stillOpen.runId, outcome: 'deliver', summary: 's' })
    // No turn/end for this one in the log at all: the turn is still running.

    const svc2 = host.service()
    await host.flush()
    void svc
    void svc2
    expect(host.run(aborted.runId)!.status).toBe('paused-error')
    expect(host.run(stillOpen.runId)!.status).toBe('active')
    expect(host.run(stillOpen.runId)!.pendingSignal).toBeDefined()
  })

  it('goal state is re-folded from the log: an active goal holds delivery after restart too', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    host.log(EXECUTOR, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 进行中回合' }] } })
    host.log(EXECUTOR, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    const svc2 = host.service()
    await host.flush()
    void svc2
    // Goal was active AT that turn end (point-in-time fold): no delivery.
    expect(host.run(bound.runId)!.phase).toBe('awaiting-delivery')
    expect(host.prompts).toHaveLength(0)

    // The goal settles, the next turn finishes — all in the log, plugin still down.
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { phase: 'complete' }, roundsStarted: 2, createdAt: 1, updatedAt: 2 })
    host.log(EXECUTOR, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 落定后的交付' }] } })
    host.log(EXECUTOR, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    const svc3 = host.service()
    await host.flush()
    void svc3
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.text).toContain('goal 落定后的交付')
  })
})

describe('outbox carry-through for nudges and legacy rows', () => {
  beforeEach(() => {})

  it('a failed nudge stays in the outbox as failed, never parks the run, and is not auto-re-sent on restart', async () => {
    const host = createFakeHost()
    host.queue.fail = true
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    void svc

    const run = host.run(bound.runId)!
    expect(run.status).toBe('active') // best-effort semantics survive the outbox
    const owed = host.outboxOf(bound.runId)
    expect(owed).toHaveLength(1)
    expect(owed[0]!.kind).toBe('nudge')
    expect(owed[0]!.state).toBe('failed')

    // Restart with a healed queue: failed outbox rows wait for MANUAL
    // redelivery (bounded reminders must not loop on their own).
    host.queue.fail = false
    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.prompts).toHaveLength(0)
    expect(host.outboxOf(bound.runId)[0]!.state).toBe('failed')
  })

  it('legacy pending delivery rows (pre-outbox data) are still re-sent on restart', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc
    // Rows written by an older build: pending in the deliveries table, no
    // outbox entry behind them.
    host.tables.deliveries.set('dlv-legacy', {
      id: 'dlv-legacy',
      runId: bound.runId,
      round: 1,
      to: EXECUTOR,
      kind: 'start',
      requestId: 'trg-legacy',
      state: 'pending',
      content: 'legacy start prompt',
      createdAt: Date.now(),
    })

    const svc2 = host.service()
    await host.flush()
    void svc2
    const sent = host.prompts.find(p => p.requestId === 'trg-legacy')
    expect(sent).toBeDefined()
    expect((host.tables.deliveries.get('dlv-legacy') as { state: string }).state).toBe('sent')
  })
})

describe('serialization of bursts on one session', () => {
  it('two back-to-back turn ends process in order without interleaving', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc

    // Round 1: deliver turn 1 (explicit signal), then the reviewer passes on
    // its own turn — both executor turn ends and the parent turn end arrive
    // in one burst; the per-session chains must keep commits serial.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '第一轮交付' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    // A second executor turn ends in the same burst (nothing pending on it).
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()

    // Exactly one review went out; the second turn end was consumed after
    // the first commit settled — the run is already awaiting-review, so an
    // executor-side auto pass or deliver nudge is out of the question.
    const reviews = host.prompts.filter(p => p.sessionId === PARENT)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.text).toContain('第一轮交付')
    const nudges = host.prompts.filter(p => p.sessionId === EXECUTOR)
    expect(nudges).toHaveLength(0)
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
  })
})

describe('review round 2: replay must not re-consume round 1 (checkpoint commit)', () => {
  it('a multi-round run restarting after a rework never resubmits round 1 as round 2', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    // Round 1: an EXPLICIT deliver whose final body is round-1-only material.
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ROUND 1 ONLY' }] } } })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '第一轮交付' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')

    // Rework: round 2 opens, waiting for a NEW delivery.
    host.emit(PARENT, { type: 'turn/start', data: { turn: 5 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'rework', summary: '改第二轮' })
    host.emit(PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await host.flush()
    const before = host.run(bound.runId)!
    expect(before.round).toBe(2)
    expect(before.phase).toBe('awaiting-delivery')
    const promptsBefore = host.prompts.length
    void svc

    // Restart: replay sees round 1's completed turn (body ROUND 1 ONLY) in
    // the log — the per-run consumption checkpoint must refuse to serve it
    // again as round 2's delivery.
    const svc2 = host.service()
    await host.flush()
    void svc2
    const after = host.run(bound.runId)!
    expect(after.round).toBe(2)
    expect(after.phase).toBe('awaiting-delivery')
    expect(host.prompts.slice(promptsBefore).some(p => p.sessionId === PARENT && p.text.includes('ROUND 1 ONLY'))).toBe(false)
    expect(host.prompts.slice(promptsBefore).some(p => p.text.includes('第2轮交付'))).toBe(false)

    // Round 2 then proceeds normally off the LIVE feed.
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '真正的第二轮交付' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
    const reviews = host.prompts.filter(p => p.sessionId === PARENT)
    expect(reviews.some(p => p.text.includes('真正的第二轮交付'))).toBe(true)
  })
})

describe('boot handoff: live events during a frozen inspect read', () => {
  it('events buffered while init waits for the log read survive into the live caches', async () => {
    const host = createFakeHost()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    host.setInspectGate(gate)
    const svc = host.service()
    // While init is blocked reading the (frozen, pre-goal) log, the session
    // starts a goal and a turn — live feed only.
    await new Promise(resolve => setTimeout(resolve, 10))
    host.emit(EXECUTOR, { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 } })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 9 } })
    release()
    await host.flush()
    void svc

    // The boot buffer must restore currentTurn (signal not refused) AND the
    // goal state (turn 9 completing mid-goal must not auto-deliver).
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 进行中' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts.filter(p => p.sessionId === EXECUTOR && p.text.includes('未收到交付信号'))).toHaveLength(0)
    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0)
  })

  it('a signal right after boot is accepted because currentTurn was rebuilt', async () => {
    const host = createFakeHost()
    const svc1 = host.service()
    const bound = await svc1.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc1
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    host.setInspectGate(gate)
    const svc2 = host.service()
    await new Promise(resolve => setTimeout(resolve, 10))
    // A turn opens while init is still blocked reading the log.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 4 } })
    release()
    await host.flush()
    const accepted = await svc2.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    expect(accepted).toMatchObject({ ok: true })
  })
})

describe('stopped runs are not re-served by the drain', () => {
  it('a cancelled run with a pending review entry never wakes the reviewer after restart', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    // Crash right after the transition write: the review sits in the outbox.
    // (The hook is installed after signal's write, so its FIRST runs.put is
    // the transition commit itself.)
    host.hooks.afterRunsPut = () => {
      host.hooks.afterRunsPut = undefined
      throw new Crash()
    }
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.outboxOf(bound.runId)).toHaveLength(1)
    expect(host.prompts).toHaveLength(0)

    // The user cancels while the plugin is down; restart must respect it.
    await svc.controlRun(bound.runId, 'cancel')
    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.run(bound.runId)!.status).toBe('cancelled')
    expect(host.prompts).toHaveLength(0)
  })

  it('a user-paused run with a pending review entry does not auto-drain either', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.hooks.afterRunsPut = () => {
      host.hooks.afterRunsPut = undefined
      throw new Crash()
    }
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    await svc.controlRun(bound.runId, 'pause')
    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.run(bound.runId)!.status).toBe('paused-user')
    expect(host.prompts).toHaveLength(0)
  })

  it('a completed run still drains its committed pass notice', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    // Drive to review, then pass — crash before the notice send.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    const reviewSent = host.prompts.length
    expect(reviewSent).toBe(1)
    let runWrites = 0
    host.hooks.afterRunsPut = () => {
      runWrites += 1
      if (runWrites === 2) {
        host.hooks.afterRunsPut = undefined
        throw new Crash()
      }
    }
    host.emit(PARENT, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'pass', summary: '通过' })
    host.emit(PARENT, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.status).toBe('completed')
    expect(host.outboxOf(bound.runId)).toHaveLength(1) // the notice is owed

    const svc2 = host.service()
    await host.flush()
    void svc2
    expect(host.prompts.at(-1)!.sessionId).toBe(EXECUTOR)
    expect(host.prompts.at(-1)!.text).toContain('审核通过')
  })
})

describe('projection/authority divergence heals on restart', () => {
  it('a failed entry whose projection write crashed is rebuilt from the authority', async () => {
    const host = createFakeHost()
    host.queue.fail = true
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    void svc
    const entry = host.outboxOf(bound.runId)[0]!
    expect(entry.state).toBe('failed')

    // Simulate the divergence the reviewer produced: the projection write
    // never landed, so the UI row is still pending with no redeliver button.
    host.tables.deliveries.set(entry.id, { ...host.tables.deliveries.get(entry.id)!, state: 'pending' })

    const svc2 = host.service()
    await host.flush()
    void svc2
    const healed = host.tables.deliveries.get(entry.id) as { state: string }
    expect(healed.state).toBe('failed') // rebuilt from the authoritative outbox
    // And manual redelivery works off the healed row.
    host.queue.fail = false
    await svc2.controlRun(bound.runId, 'redeliver', { deliveryId: entry.id })
    expect(host.prompts.at(-1)!.requestId).toBe(entry.requestId)
  })

  it('a sent projection with the entry still in the outbox clears via deduped re-drain', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    void svc
    // The review was admitted and the projection turned sent…
    expect(host.prompts).toHaveLength(1)
    const sentRow = [...host.tables.deliveries.values()].find(d => (d as { kind: string }).kind === 'review') as { id: string, requestId: string, state: string }
    expect(sentRow.state).toBe('sent')
    // …but the crash hit before the entry left the outbox: rebuild exactly
    // that diverged authority state by hand (deterministic window).
    const run = host.run(bound.runId)!
    const diverged: OutboxEntry = {
      id: sentRow.id,
      runId: bound.runId,
      round: run.round,
      to: PARENT,
      kind: 'review',
      requestId: sentRow.requestId,
      state: 'pending',
      content: 're-drain drill',
      createdAt: Date.now(),
    }
    host.tables.runs.set(bound.runId, { ...run, outbox: [diverged] })

    const svc2 = host.service()
    await host.flush()
    void svc2
    // Re-drain under the same requestId: the queue deduped — still exactly
    // one admitted copy — and the authority (outbox) is cleared.
    expect(host.prompts).toHaveLength(1)
    expect(host.outboxOf(bound.runId)).toHaveLength(0)
  })
})

describe('same-run read-modify-write serialization under host-realistic puts', () => {
  it('concurrent cancel and extend never resurrect the run', async () => {
    const host = createFakeHost()
    host.slowPuts.runs = true
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT, maxRounds: 3 })
    await Promise.allSettled([
      svc.controlRun(bound.runId, 'cancel'),
      svc.controlRun(bound.runId, 'extend', { newMaxRounds: 6 }),
    ])
    await host.flush()
    const run = host.run(bound.runId)!
    expect(run.status).toBe('cancelled')
  })

  it('a turn-end commit racing a cancel lands on one side, never both', async () => {
    const host = createFakeHost()
    host.slowPuts.runs = true
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    await Promise.allSettled([
      svc.controlRun(bound.runId, 'cancel'),
      (async () => {
        host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        await host.flush()
      })(),
    ])
    await host.flush()
    const run = host.run(bound.runId)!
    // Either the cancel won (terminal, nothing owed) or the transition won
    // (awaiting-review with exactly one review owed) — never a cancelled run
    // with a review still in the outbox, never an active run half-advanced.
    if (run.status === 'cancelled') {
      expect(host.outboxOf(bound.runId).filter(e => e.kind === 'review' && e.state === 'pending')).toHaveLength(0)
    } else {
      expect(run.phase).toBe('awaiting-review')
    }
  })
})

describe('round 3: legacy-record migration must not lose sides or swallow verdicts', () => {
  /** Drop the checkpoint field from a run record, simulating a pre-checkpoint build. */
  const stripCheckpoint = (host: ReturnType<typeof createFakeHost>, runId: string): void => {
    const run = { ...(host.tables.runs.get(runId) as object) } as Record<string, unknown>
    delete run.consumedTurns
    host.tables.runs.set(runId, run)
  }

  it('a legacy multi-round record migrates BOTH sides at once; round 1 stays consumed', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ROUND 1 ONLY' }] } } })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '第一轮交付' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    host.emit(PARENT, { type: 'turn/start', data: { turn: 5 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'rework', summary: '改第二轮' })
    host.emit(PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.round).toBe(2)
    const promptsBefore = host.prompts.length
    void svc

    // Legal upgrade record: the pre-checkpoint build never wrote the field.
    stripCheckpoint(host, bound.runId)
    const svc2 = host.service()
    await host.flush()
    void svc2

    const after = host.run(bound.runId)!
    expect(after.phase).toBe('awaiting-delivery')
    expect(after.round).toBe(2)
    // BOTH sides migrated: neither round 1's turn nor the rework turn replays.
    expect(host.prompts.slice(promptsBefore).some(p => p.text.includes('ROUND 1 ONLY'))).toBe(false)
    expect(host.prompts.slice(promptsBefore).some(p => p.text.includes('第2轮交付'))).toBe(false)
    // And the merged checkpoint carries both sides.
    expect(after.consumedTurns).toMatchObject({ executor: 1, parent: 5 })
  })

  it('a legacy pending REVIEWER verdict whose turn end is only in the log still commits', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '第一轮' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')

    // The reviewer signaled; its turn ended completed in the log only.
    host.emit(PARENT, { type: 'turn/start', data: { turn: 5 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'rework', summary: '改第二轮' })
    host.log(PARENT, 'turn/end', { turn: 5, reason: { kind: 'completed' } })
    stripCheckpoint(host, bound.runId)
    void svc

    const svc2 = host.service()
    await host.flush()
    void svc2
    const after = host.run(bound.runId)!
    expect(after.phase).toBe('awaiting-delivery')
    expect(after.round).toBe(2)
    expect(after.pendingSignal).toBeUndefined()
    const rework = host.prompts.filter(p => p.sessionId === EXECUTOR && p.text.includes('改第二轮'))
    expect(rework).toHaveLength(1)
  })

  it('a legacy pending EXECUTOR deliver whose turn end is only in the log still commits', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 3 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '执行侧交付' })
    host.log(EXECUTOR, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
    stripCheckpoint(host, bound.runId)
    void svc

    const svc2 = host.service()
    await host.flush()
    void svc2
    const after = host.run(bound.runId)!
    expect(after.phase).toBe('awaiting-review')
    expect(after.pendingSignal).toBeUndefined()
    expect(host.prompts.some(p => p.sessionId === PARENT && p.text.includes('执行侧交付'))).toBe(true)
  })

  it('a legacy pending signal whose logged turn ended abnormally parks instead of being swallowed', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '第一轮' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    host.emit(PARENT, { type: 'turn/start', data: { turn: 6 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'pass', summary: '通过' })
    host.log(PARENT, 'turn/end', { turn: 6, reason: { kind: 'aborted' } })
    stripCheckpoint(host, bound.runId)
    void svc

    const svc2 = host.service()
    await host.flush()
    void svc2
    const after = host.run(bound.runId)!
    expect(after.status).toBe('paused-error')
    expect(after.pendingSignal).toBeUndefined()
  })
})

describe('round 3: a cold goal in the log must gate boot-time turn ends', () => {
  it('goal active in the frozen log holds a turn that ends during boot', async () => {
    const host = createFakeHost()
    const svc1 = host.service()
    const bound = await svc1.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    void svc1
    // The durable log now carries an ACTIVE goal, recorded before the crash.
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    host.setInspectGate(gate)
    // Restart: init blocks reading the (frozen) executor log.
    const svc2 = host.service()
    await new Promise(resolve => setTimeout(resolve, 10))
    // While init is blocked, the executor works and finishes a turn — live
    // feed only. The empty pre-seed cache must not freeze goalActive=false.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 9 } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 进行中的回合' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    release()
    await host.flush()
    void svc2

    const run = host.run(bound.runId)!
    expect(run.phase).toBe('awaiting-delivery') // goal active at that turn end: no premature review
    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0)
  })

  it('a goal active since before the plugin started also gates a fresh bind first turn', async () => {
    const host = createFakeHost()
    const svc = host.service()
    // No run existed at boot, so startup replay seeded nothing; the goal is
    // cold history in the executor's log. A fresh bind must still see it.
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 首个回合' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-delivery')
    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0)
  })
})

describe('round 4: seeding must not mistake a transient live fold for a seeded one', () => {
  it('a live user/message before the bind does not hide the cold log goal', async () => {
    const host = createFakeHost()
    const svc = host.service()
    await host.flush() // init done; no active run, so nothing was ever seeded
    // Cold history: an ACTIVE goal, recorded in the log before this plugin saw anything.
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    // The exact repro: one live event of a kind the fold ignores still
    // creates a TRANSIENT cache entry — seeding must not treat that as done.
    host.emit(EXECUTOR, { type: 'user/message', data: { turn: 0, message: { role: 'user', content: [] } } })

    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 中的回合' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-delivery') // cold goal gates the delivery
    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0)
  })

  it('a turn/start arriving DURING the seeding read merges over the baseline: goal kept, turn kept', async () => {
    const host = createFakeHost()
    const svc = host.service()
    await host.flush()
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    host.setInspectGate(gate)
    // The bind reaches seedFold and blocks inside the (frozen) log read.
    const binding = svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    await new Promise(resolve => setTimeout(resolve, 10))
    // A turn opens while the read is in flight — buffered by the seeding.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 7 } })
    release()
    const bound = await binding

    // The cold goal survived the merge: turn 7 completing does not deliver.
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 中的第 7 回合' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-delivery')
    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0)

    // And the fold is fully alive afterwards: the goal settles, the next
    // turn delivers — currentTurn and replies were not lost by the merge.
    host.emit(EXECUTOR, { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'complete', goal: { phase: 'complete' }, roundsStarted: 2, createdAt: 1, updatedAt: 2 } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 8, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 落定交付' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(bound.runId)!.phase).toBe('awaiting-review')
    expect(host.prompts.some(p => p.sessionId === PARENT && p.text.includes('goal 落定交付'))).toBe(true)
  })

  it('an already-seeded session is never re-seeded over live progress', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const first = await svc.bindReviewLoop({ task: 't1', executorSession: EXECUTOR, parentSession: PARENT })
    // Advance live: deliver round 1, so the executor's fold carries live state.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: first.runId, outcome: 'deliver', summary: '第一轮' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(first.runId)!.phase).toBe('awaiting-review')

    // A second loop binds the SAME executor: seeding must early-return on
    // the seeded marker, not overwrite the fold with a stale snapshot (the
    // old log still ends mid-turn-1; a re-seed would resurrect old state).
    const second = await svc.bindReviewLoop({ task: 't2', executorSession: EXECUTOR, parentSession: 'sess-parent-2' })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    const accepted = await svc.signal(EXECUTOR, { runId: second.runId, outcome: 'deliver', summary: '第二个循环' })
    expect(accepted).toMatchObject({ ok: true }) // currentTurn=2 still live
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.run(second.runId)!.phase).toBe('awaiting-review')
    expect(host.run(first.runId)!.phase).toBe('awaiting-review')
  })
})

describe('round 5: seeding is shared and buffer timing is point-in-time', () => {
  it('a second bind of the same session WAITS for the in-flight seed instead of racing past it', async () => {
    const host = createFakeHost()
    const svc = host.service()
    await host.flush()
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    host.setInspectGate(gate)
    const bindA = svc.bindReviewLoop({ task: 'A', executorSession: EXECUTOR, parentSession: PARENT })
    await new Promise(resolve => setTimeout(resolve, 10))
    const bindB = svc.bindReviewLoop({ task: 'B', executorSession: EXECUTOR, parentSession: 'sess-parent-2' })
    await new Promise(resolve => setTimeout(resolve, 10))
    // The seed is still in flight: bind B must NOT have returned with a run
    // built against a baseline that never landed.
    const outcome = await Promise.race([
      bindB.then(() => 'returned' as const),
      new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 30)),
    ])
    expect(outcome).toBe('waiting')
    // A turn opens while the read is frozen — it lands in the seed buffer.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 7 } })
    release()
    const a = await bindA
    const b = await bindB
    // Both runs exist and the buffered turn survived into the fold: a signal
    // for B is accepted against currentTurn=7.
    const accepted = await svc.signal(EXECUTOR, { runId: b.runId, outcome: 'needs_user', summary: '问一下' })
    expect(accepted).toMatchObject({ ok: true })
    void a
  })

  it('buffered goal changes gate buffered turn ends point-in-time: turn 7 holds, turn 8 delivers the real final', async () => {
    const host = createFakeHost()
    const svc1 = host.service()
    const bound = await svc1.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    // Park the run, then let the log go cold with an ACTIVE goal.
    await svc1.controlRun(bound.runId, 'pause')
    host.log(EXECUTOR, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 })
    void svc1
    // Restart: a paused run seeds nothing, so the executor has no baseline.
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    host.setInspectGate(gate)
    const svc2 = host.service()
    await host.flush()
    // Resume: the run chain seeds the executor BEFORE reviving the run — and
    // the read is frozen, so the resume is parked mid-seed.
    const resumed = svc2.controlRun(bound.runId, 'resume')
    await new Promise(resolve => setTimeout(resolve, 10))
    // The buffered sequence: turn 7 finishes while the goal is still ACTIVE,
    // the goal then settles, turn 8 carries the actual final.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 7 } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'GOAL STILL ACTIVE intermediate' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    host.emit(EXECUTOR, { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'complete', goal: { phase: 'complete' }, roundsStarted: 2, createdAt: 1, updatedAt: 2 } })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 8 } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 8, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'actual final' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    release()
    await resumed
    await host.flush()
    void svc2

    // Turn 7 was judged AT ITS OWN MOMENT (goal still active): held, never
    // reviewed. Turn 8 delivered the actual final.
    const run = host.run(bound.runId)!
    expect(run.phase).toBe('awaiting-review')
    const reviews = host.prompts.filter(p => p.sessionId === PARENT)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.text).toContain('actual final')
    expect(reviews[0]!.text).not.toContain('GOAL STILL ACTIVE intermediate')
  })
})
