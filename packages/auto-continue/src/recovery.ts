/**
 * Recovery owner for quota/rate-limited model requests.
 *
 * Listens on the `agent/request-error` waterfall downstream of the built-in
 * `llm-retry` executor: `QUOTA` failures are never in its default retryable
 * set and reach us immediately; `RATE_LIMIT` reaches us once its bounded
 * budget is exhausted (or an `always` policy defers downstream first).
 *
 * For each owned failure we plan one wait — until the quota API's reported
 * window reset when the `planUsage` service (dsh-plan-usage) is mounted and
 * answers, or a staged probe otherwise — record it durably as an `llm/retry`
 * event (the stock Web conversation view renders the countdown for free),
 * sleep cancellably, then return `{ kind: 'retry' }` so the loop re-runs the
 * failed step inside the same open turn over the same durable history: no
 * "continue" message, no extra prompt tokens, and the rebuilt request can
 * still hit the provider's prompt cache.
 *
 * @module dsh-auto-continue/recovery
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from './shims.js'
import type { ScheduleOptions, WaitPlan } from './schedule.js'
import { planProbeWait, planResetWait } from './schedule.js'
import type { PendingWait, WaitSpool } from './spool.js'

/** Failure codes this plugin owns. */
const OWNED_CODES = new Set(['QUOTA', 'RATE_LIMIT'])

/** Wait bookkeeping for one open turn of one session. */
interface WaitState {
  firstFailureAt: number
  attempts: number
  probes: number
}

export interface RecoveryConfig extends ScheduleOptions {
  /** Durable wait records; `undefined` disables persistence entirely. */
  spool?: WaitSpool
  /** Called when a wait is kept after its turn aborted (user stop, relay
   *  teardown, shutdown ordering) so the in-process adopter re-arms it. */
  onWaitKept?: (entry: PendingWait) => void
  /** Session ids whose wait the user cancelled via /ac-cancel; the sleeping
   *  recovery checks it at wake and stands down without retrying. */
  cancelled?: Set<string>
}

/** Hard cap on tracked turn states; the map is pruned to its first entries. */
const MAX_TRACKED_STATES = 64
/** Single sleep chunks below ~12 days so setTimeout never overflows. */
const SLEEP_CHUNK_MS = 2 ** 30

/** Sleep `delayMs` unless `signal` aborts; resolves false when aborted. */
export function cancellableSleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(!signal.aborted)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let remaining = delayMs
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean): void => {
      signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    const tick = (): void => {
      if (remaining <= 0) {
        finish(true)
        return
      }
      timer = setTimeout(() => {
        remaining -= SLEEP_CHUNK_MS
        tick()
      }, Math.min(remaining, SLEEP_CHUNK_MS))
    }
    function onAbort(): void {
      finish(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    tick()
  })
}

/**
 * Register the recovery owner on `agent/request-error`. Every side effect —
 * the listener, the lifetime controller, in-flight waits — unwinds on plugin
 * disposal.
 */
export function registerRecovery(ctx: Context, config: RecoveryConfig): void {
  const spool = config.spool
  const lifetime = new AbortController()
  const states = new Map<string, WaitState>()
  const active = new Set<Promise<unknown>>()

  const stateFor = (sessionId: string, turn: number): WaitState => {
    const key = `${sessionId}#${turn}`
    let state = states.get(key)
    if (state === undefined) {
      // Prune older turns of the same session, then enforce the size cap.
      for (const other of states.keys()) {
        if (other.startsWith(`${sessionId}#`) && other !== key) states.delete(other)
      }
      while (states.size >= MAX_TRACKED_STATES) {
        const oldest = states.keys().next().value
        if (oldest === undefined) break
        states.delete(oldest)
      }
      state = { firstFailureAt: Date.now(), attempts: 0, probes: 0 }
      states.set(key, state)
    }
    return state
  }

  const dropState = (sessionId: string, turn: number): void => {
    states.delete(`${sessionId}#${turn}`)
  }

  /** Choose the next wait for one owned failure. */
  const plan = async (provider: string, state: WaitState): Promise<WaitPlan> => {
    const now = Date.now()
    const elapsed = now - state.firstFailureAt
    const usage = ctx.get('planUsage')
    if (usage !== undefined) {
      const snapshot = await usage.get(provider).catch(() => undefined)
      const resetPlan = planResetWait(snapshot, now, elapsed, config)
      if (!(resetPlan.kind === 'wait' && resetPlan.window === 'probe')) return resetPlan
    }
    return planProbeWait(now, elapsed, state.probes++, config)
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    const operation = (async () => {
      const { agent, turn, step, provider, failure, signal } = payload
      if (!OWNED_CODES.has(failure.code)) return next()
      const state = stateFor(agent.session.id, turn)
      const fused = AbortSignal.any([signal, lifetime.signal])

      const wait = await plan(provider, state)
      if (wait.kind === 'give-up') {
        ctx.logger.warn(`auto-continue: giving up on ${failure.code} from "${provider}" — ${wait.reason}`)
        dropState(agent.session.id, turn)
        await spool?.delete(agent.session.id)
        return next()
      }

      state.attempts += 1
      const retryId = randomUUID()
      const recorded = agent.session.append('llm/retry', {
        retryId,
        turn,
        step,
        provider,
        mode: 'always',
        policyKey: '"auto-continue"',
        retry: state.attempts,
        delayMs: wait.delayMs,
        failure,
      })
      ctx.logger.info(
        'auto-continue: %s from "%s" — scheduled retry %d in %d min%s',
        failure.code,
        provider,
        state.attempts,
        Math.round(wait.delayMs / 60000),
        wait.retryAt === undefined ? ' (probe)' : ` (until ${new Date(wait.retryAt).toISOString()})`,
      )

      // Persist before sleeping: a process restart (or plugin update) during
      // the wait leaves this record for the resumption adopter to pick up.
      const entry: PendingWait = {
        sessionId: agent.session.id,
        provider,
        code: failure.code,
        turn,
        step,
        lastSeq: recorded.seq,
        firstFailureAt: state.firstFailureAt,
        attempts: state.attempts,
        probes: state.probes,
        retryAt: Date.now() + wait.delayMs,
      }
      await spool?.set(entry)

      const slept = await cancellableSleep(wait.delayMs, fused)
      if (slept && config.cancelled?.has(agent.session.id)) {
        // The user cancelled while we slept: stand down without retrying.
        config.cancelled.delete(agent.session.id)
        dropState(agent.session.id, turn)
        await spool?.delete(agent.session.id)
        return undefined
      }
      if (!slept) {
        dropState(agent.session.id, turn)
        // A turn abort is NOT an instruction to abandon the wait: it can be a
        // user stop, a relay peer tearing the turn down, or graceful-shutdown
        // ordering — so the record is always kept, and when the plugin itself
        // is not being disposed the in-process adopter re-arms it. (A session
        // the user has since driven is stood down at resume time by the
        // newer-user-message guard; the budget deadline bounds everything.)
        if (!lifetime.signal.aborted) config.onWaitKept?.(entry)
        return undefined
      }
      await spool?.delete(agent.session.id)
      agent.session.append('llm/retry-started', { retryId, turn, step, retry: state.attempts })
      return { kind: 'retry' as const }
    })()
    active.add(operation)
    operation.finally(() => active.delete(operation))
    return operation
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('auto-continue plugin disposed'))
    await Promise.allSettled([...active])
  }, 'auto-continue: abort and drain active recovery')
}
