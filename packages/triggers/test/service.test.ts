/**
 * Service-level orchestration tests over a fake host surface: the loop end to
 * end (bind → signal → turn end → queued prompt), duplicate/replayed turn
 * ends, late signals, failed deliveries parking the run, and the restart
 * recovery scan (pending signal parks, pending delivery re-sends under the
 * same requestId).
 *
 * @module dsh-triggers/service.test
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { TriggerService } from '../src/service.js'
import type { RunRecord } from '../src/model.js'
import { BUILTIN_REVIEW_TEMPLATE, BUILTIN_REWORK_TEMPLATE, BUILTIN_START_TEMPLATE } from '../src/identity.js'

interface FakePromptCall {
  requestId: string
  sessionId: string
  mode: string
  text: string
}

/** A minimal host surface satisfying everything TriggerService touches. */
function createFakeHost() {
  const tables = {
    templates: new Map<string, unknown>(),
    bindings: new Map<string, unknown>(),
    runs: new Map<string, unknown>(),
    deliveries: new Map<string, unknown>(),
  }
  const listeners = new Map<string, Array<(session: { id: string }, event: unknown) => void>>()
  const prompts: FakePromptCall[] = []
  /** Flip to true to make the queue refuse every send (failure drills). */
  const queue = { fail: false }

  const tableFor = (name: keyof typeof tables) => ({
    get: (key: string) => tables[name].get(key),
    entries: () => tables[name].entries() as IterableIterator<[string, never]>,
    keys: () => tables[name].keys() as IterableIterator<string>,
    get size() { return tables[name].size },
    put: async (key: string, value: unknown) => {
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
        prompts.push({
          requestId: request.requestId,
          sessionId: request.sessionId,
          mode: request.mode,
          text: request.content[0]?.text ?? '',
        })
        return { accepted: true as const }
      },
      list: async () => ({ items: [] }),
    },
    tools: { register: () => () => {} },
  }

  const emit = (sessionId: string, event: { type: string, data: unknown }): void => {
    for (const listener of listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 5))
  }
  const service = (): TriggerService => new TriggerService(ctx as never, {})
  return { tables, prompts, queue, emit, flush, service }
}

const EXECUTOR = 'sess-exec'
const PARENT = 'sess-parent'

describe('loop end to end', () => {
  const host = createFakeHost()
  const svc = host.service()

  beforeEach(() => {
    host.prompts.length = 0
  })

  it('binds, delivers nothing by default, and advances on the signal turn end', async () => {
    const bound = await svc.bindReviewLoop({ task: '修复构建', executorSession: EXECUTOR, parentSession: PARENT, maxRounds: 5 })
    expect(bound.runId).toMatch(/^run-/)
    // handoff-style bind sends no start prompt of its own
    expect(host.prompts).toHaveLength(0)
    const run = host.tables.runs.get(bound.runId) as RunRecord
    expect(run.phase).toBe('awaiting-delivery')

    // executor signals inside turn 3
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 3 } })
    const accepted = await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: '实现完成，测试 12/12' })
    expect(accepted).toMatchObject({ ok: true })
    // the turn has NOT ended yet: nothing queued
    expect(host.prompts).toHaveLength(0)

    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.sessionId).toBe(PARENT)
    expect(host.prompts[0]!.mode).toBe('queue')
    expect(host.prompts[0]!.text).toContain(bound.runId)
    expect(host.prompts[0]!.text).toContain('实现完成，测试 12/12')
    expect((host.tables.runs.get(bound.runId) as RunRecord).phase).toBe('awaiting-review')
  })

  it('rework queues round 2 to the executor; pass finishes with a notice', async () => {
    const bound = await svc.bindReviewLoop({ task: '任务B', executorSession: EXECUTOR, parentSession: PARENT })

    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 'round1' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()

    host.emit(PARENT, { type: 'turn/start', data: { turn: 8 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'rework', summary: '修 e2e' })
    host.emit(PARENT, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    await host.flush()

    const afterRework = host.tables.runs.get(bound.runId) as RunRecord
    expect(afterRework.phase).toBe('awaiting-delivery')
    expect(afterRework.round).toBe(2)
    const reworkPrompt = host.prompts.at(-1)!
    expect(reworkPrompt.sessionId).toBe(EXECUTOR)
    expect(reworkPrompt.text).toContain('修 e2e')

    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 'round2' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    host.emit(PARENT, { type: 'turn/start', data: { turn: 9 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'pass', summary: '通过' })
    host.emit(PARENT, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    await host.flush()

    expect((host.tables.runs.get(bound.runId) as RunRecord).status).toBe('completed')
    expect(host.prompts.at(-1)!.sessionId).toBe(EXECUTOR)
    expect(host.prompts.at(-1)!.text).toContain('审核通过')
  })
})

describe('abuse and stop paths through the service', () => {
  it('a replayed or duplicate turn end never queues twice', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    // replay of the same persisted event (restart replay, at-least-once observer…)
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
  })

  it('a signal without a tracked turn is refused', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    const result = await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    expect(result).toMatchObject({ ok: false })
  })

  it('a completed run refuses late signals', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    await svc.controlRun(bound.runId, 'cancel')
    const result = await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 'late' })
    expect(result).toMatchObject({ ok: false })
  })

  it('pause keeps the run; an abnormal signal turn parks it', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    const paused = await svc.controlRun(bound.runId, 'pause')
    expect(paused.status).toBe('paused-user')
    const resumed = await svc.controlRun(bound.runId, 'resume', { message: '继续' })
    expect(resumed.status).toBe('active')
    expect(host.prompts.at(-1)!.sessionId).toBe(EXECUTOR)
    expect(host.prompts.at(-1)!.text).toContain('继续')

    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 4 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted' } } })
    await host.flush()
    expect((host.tables.runs.get(bound.runId) as RunRecord).status).toBe('paused-error')
    expect(host.prompts).toHaveLength(1) // only the resume note; nothing advanced
  })

  it('needs_user from the executor notifies the parent and pauses', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'needs_user', summary: '选哪个方案？' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    const run = host.tables.runs.get(bound.runId) as RunRecord
    expect(run.status).toBe('paused-user')
    expect(run.pausedBy).toBe('executor')
    expect(host.prompts.at(-1)!.sessionId).toBe(PARENT)
    expect(host.prompts.at(-1)!.text).toContain('选哪个方案？')
  })
})

describe('delivery failures', () => {
  it('a refused queue send marks the delivery failed and parks the run; redeliver recovers', async () => {
    const host = createFakeHost()
    host.queue.fail = true
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()

    const run = host.tables.runs.get(bound.runId) as RunRecord
    expect(run.status).toBe('paused-error')
    const delivery = [...host.tables.deliveries.values()].at(-1) as { id: string, requestId: string, state: string, error?: string }
    expect(delivery.state).toBe('failed')
    expect(delivery.error).toBeDefined()

    // The queue heals; redelivering reuses the SAME requestId.
    host.queue.fail = false
    await svc.controlRun(bound.runId, 'redeliver', { deliveryId: delivery.id })
    const resent = host.prompts.at(-1)!
    expect(resent.requestId).toBe(delivery.requestId)
  })
})

describe('restart recovery', () => {
  it('parks a run whose signal never saw its turn end, and re-sends pending deliveries under the same requestId', async () => {
    const host = createFakeHost()
    const svc1 = host.service()
    const bound = await svc1.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT, deliverStart: true })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    const startDelivery = [...host.tables.deliveries.values()].at(-1) as { id: string, requestId: string, state: string }
    expect(startDelivery.state).toBe('sent')

    // Crash before the turn ends: a signal is pending, and (simulated) a
    // queued-but-unconfirmed delivery.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    await svc1.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.tables.deliveries.set(startDelivery.id, { ...startDelivery, state: 'pending' })

    const svc2 = host.service()
    await host.flush()
    const run = host.tables.runs.get(bound.runId) as RunRecord
    expect(run.status).toBe('paused-error')
    expect(run.pendingSignal).toBeUndefined()
    // pending delivery re-sent with the SAME requestId (idempotent replay)
    const resent = host.prompts.filter(p => p.requestId === startDelivery.requestId)
    expect(resent).toHaveLength(2)
    void svc2
  })
})

describe('built-in template seeding', () => {
  it('seeds the three built-ins on first open', async () => {
    const host = createFakeHost()
    host.service()
    await host.flush()
    expect(host.tables.templates.has(BUILTIN_START_TEMPLATE)).toBe(true)
    expect(host.tables.templates.has(BUILTIN_REVIEW_TEMPLATE)).toBe(true)
    expect(host.tables.templates.has(BUILTIN_REWORK_TEMPLATE)).toBe(true)
  })
})

describe('turn-end auto-delivery', () => {
  it('submits the executor final reply when the turn ends completed', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: '任务', executorSession: EXECUTOR, parentSession: PARENT })
    expect((host.tables.bindings.get(bound.bindingId) as { autoDeliver?: boolean }).autoDeliver).toBe(true)

    // The executor works and just… finishes its reply. No tool call.
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 2, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '实现完成；54/54 通过，证据在 lib/ 目录' }] } } })
    await host.flush()
    expect(host.prompts).toHaveLength(0) // nothing until the turn ends

    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.sessionId).toBe(PARENT)
    expect(host.prompts[0]!.text).toContain('实现完成；54/54 通过')
    expect((host.tables.runs.get(bound.runId) as RunRecord).phase).toBe('awaiting-review')
  })

  it('uses the LAST non-empty reply of a multi-step turn', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '中间步骤输出' }] } } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 4, message: { role: 'assistant', content: [{ type: 'text', text: '最终交付说明' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.text).toContain('最终交付说明')
    expect(host.prompts[0]!.text).not.toContain('中间步骤输出')
    void bound
  })

  it('holds delivery while the executor session has an active goal, then delivers once it settles', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })

    host.emit(EXECUTOR, { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 1 } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'goal 第 1 轮进展' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(0) // goal may continue: no premature delivery

    host.emit(EXECUTOR, { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'complete', goal: { phase: 'complete' }, roundsStarted: 2, createdAt: 1, updatedAt: 2 } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '目标完成，最终交付' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.text).toContain('最终交付')
    expect((host.tables.runs.get(bound.runId) as RunRecord).phase).toBe('awaiting-review')
  })

  it('an explicit signal still wins; the same turn never auto-delivers a second run', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const first = await svc.bindReviewLoop({ task: 't1', executorSession: EXECUTOR, parentSession: PARENT })
    const second = await svc.bindReviewLoop({ task: 't2', executorSession: EXECUTOR, parentSession: 'sess-parent-2' })

    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 6 } })
    await svc.signal(EXECUTOR, { runId: first.runId, outcome: 'deliver', summary: '显式交付' })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 6, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '同回合最终回复' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
    await host.flush()
    // only the explicit run advanced; the second loop was not dragged along
    expect((host.tables.runs.get(first.runId) as RunRecord).phase).toBe('awaiting-review')
    expect((host.tables.runs.get(second.runId) as RunRecord).phase).toBe('awaiting-delivery')
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.text).toContain('显式交付')
  })

  it('a completed turn with no final reply nudges once, then stays quiet', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]!.sessionId).toBe(EXECUTOR)
    expect(host.prompts[0]!.text).toContain('没有可作为交付说明的最终回复')

    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1) // bounded: no second nudge in the same round
    expect((host.tables.runs.get(bound.runId) as RunRecord).phase).toBe('awaiting-delivery')
  })
})

describe('missing-conclusion nudges', () => {
  it('tool-only bindings get one deliver nudge per round after a signal-less completed turn', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const saved = await svc.saveBinding({ executor: EXECUTOR, parent: PARENT, name: '手工绑定' })
    expect(saved.autoDeliver).toBeUndefined()
    await svc.startRunFromBinding(saved.id)
    await host.flush()
    const startPrompts = host.prompts.length // the start delivery itself

    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(startPrompts + 1)
    expect(host.prompts.at(-1)!.sessionId).toBe(EXECUTOR)
    expect(host.prompts.at(-1)!.text).toContain('未收到交付信号')

    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(startPrompts + 1)
  })

  it('a reviewer turn without a verdict gets one review nudge after the review prompt landed', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    // deliver round 1 explicitly so a review delivery record exists
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(1)

    // reviewer chats with the user and ends the turn without a verdict
    host.emit(PARENT, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(2)
    expect(host.prompts[1]!.sessionId).toBe(PARENT)
    expect(host.prompts[1]!.text).toContain('仍在等待审核结论')

    host.emit(PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await host.flush()
    expect(host.prompts).toHaveLength(2) // once per round, no loop
  })

  it('no review nudge before the review prompt has actually been sent', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT, deliverStart: true })
    await host.flush()
    // run is awaiting-delivery; a reviewer turn end must not nudge for review
    host.emit(PARENT, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    await host.flush()
    const reviewNudges = host.prompts.filter(p => p.text.includes('仍在等待审核结论'))
    expect(reviewNudges).toHaveLength(0)
    void bound
  })

  it('a failed nudge send is best-effort: logged, never parking the run', async () => {
    const host = createFakeHost()
    host.queue.fail = true
    const svc = host.service()
    await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    const run = [...host.tables.runs.values()].at(-1) as RunRecord
    expect(run.status).toBe('active') // not parked by a failed reminder
    const nudge = [...host.tables.deliveries.values()].at(-1) as { kind: string, state: string }
    expect(nudge.kind).toBe('nudge')
    expect(nudge.state).toBe('failed')
  })
})

describe('rework round 2: turn ownership, empty finals, and nudge recovery', () => {
  it('two auto runs on one executor: one reply advances NEITHER; each gets an ambiguity nudge that demands an explicit signal', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const first = await svc.bindReviewLoop({ task: '任务 A', executorSession: EXECUTOR, parentSession: PARENT })
    const second = await svc.bindReviewLoop({ task: '任务 B', executorSession: EXECUTOR, parentSession: 'sess-parent-2' })

    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 5, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Only task A completed' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await host.flush()

    // No review anywhere: the reply cannot be attributed to one task.
    expect(host.prompts.filter(p => p.sessionId === PARENT || p.sessionId === 'sess-parent-2')).toHaveLength(0)
    expect((host.tables.runs.get(first.runId) as RunRecord).phase).toBe('awaiting-delivery')
    expect((host.tables.runs.get(second.runId) as RunRecord).phase).toBe('awaiting-delivery')
    // Each waiting run reminds once (bounded per round); the FULL composed
    // prompt must demand an explicit trigger_signal naming its runId…
    const nudges = host.prompts.filter(p => p.sessionId === EXECUTOR && p.text.includes('必须调用 trigger_signal'))
    expect(nudges).toHaveLength(2)
    const nudgeForFirst = nudges.find(p => p.text.includes(`runId=${first.runId}`))!
    const nudgeForSecond = nudges.find(p => p.text.includes(`runId=${second.runId}`))!
    expect(nudgeForFirst).toBeDefined()
    expect(nudgeForSecond).toBeDefined()
    // …and must NOT carry the standing auto rules, whose "a normal turn end
    // delivers itself" promise would cancel the only recovery path.
    for (const nudge of [nudgeForFirst!, nudgeForSecond!]) {
      expect(nudge.text).not.toContain('无需调用工具')
      expect(nudge.text).not.toContain('正常结束回合即自动送审')
      expect(nudge.text).not.toContain('即视为交付')
      expect(nudge.text).not.toContain('执行—审核循环') // the standing block is absent entirely
      expect(nudge.text).not.toContain('对方发来的内容')
    }

    // A later explicit signal for ONE run still works and advances only it.
    host.emit(EXECUTOR, { type: 'turn/start', data: { turn: 6 } })
    await svc.signal(EXECUTOR, { runId: first.runId, outcome: 'deliver', summary: '显式交付 A' })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
    await host.flush()
    expect((host.tables.runs.get(first.runId) as RunRecord).phase).toBe('awaiting-review')
    expect((host.tables.runs.get(second.runId) as RunRecord).phase).toBe('awaiting-delivery')
    const reviews = host.prompts.filter(p => p.sessionId === PARENT)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.text).toContain('显式交付 A')
  })

  it('an empty final assistant message never falls back to an earlier intermediate text', async () => {
    const host = createFakeHost()
    const svc = host.service()
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })

    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect the failing test next' }] } } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()

    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0) // no review
    const run = host.tables.runs.get(bound.runId) as RunRecord
    expect(run.phase).toBe('awaiting-delivery')
    const nudge = host.prompts.find(p => p.sessionId === EXECUTOR)
    expect(nudge?.text).toContain('没有可作为交付说明的最终回复')
    for (const p of host.prompts) expect(p.text).not.toContain('inspect the failing test')
  })

  it('a whitespace-only final message counts as empty too', async () => {
    const host = createFakeHost()
    const svc = host.service()
    await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })

    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '中间输出' }] } } })
    host.emit(EXECUTOR, { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '   \n  ' }] } } })
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()

    expect(host.prompts.filter(p => p.sessionId === PARENT)).toHaveLength(0)
    expect(host.prompts.some(p => p.sessionId === EXECUTOR && p.text.includes('没有可作为交付说明的最终回复'))).toBe(true)
  })

  it('a pending nudge that fails to re-send after a restart never parks the run', async () => {
    const host = createFakeHost()
    const svc1 = host.service()
    await svc1.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    // Produce one persisted nudge and force it back to pending (crash window).
    host.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await host.flush()
    const nudge = [...host.tables.deliveries.values()].at(-1) as { id: string, kind: string, state: string }
    expect(nudge.kind).toBe('nudge')

    host.tables.deliveries.set(nudge.id, { ...nudge, state: 'pending' })
    host.queue.fail = true
    host.prompts.length = 0
    const svc2 = host.service()
    await host.flush()

    const run = [...host.tables.runs.values()].at(-1) as RunRecord
    expect(run.status).toBe('active') // best-effort semantics survive the restart
    const after = host.tables.deliveries.get(nudge.id) as { kind: string, state: string }
    expect(after.state).toBe('failed')
    void svc2
  })
})
