import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { LlmRetryEventData } from './shims.js'
import type { ScheduleOptions, WaitPlan } from './schedule.js'
import { planProbeWait, planResetWait } from './schedule.js'
import type { PendingWait, WaitSpool } from './spool.js'

const QUOTA_CODES = new Set(['QUOTA', 'RATE_LIMIT'])
const TRANSIENT_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])
const TRANSIENT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000]
const MAX_TRANSIENT_DELAY_MS = 120_000
const OUTAGE_MESSAGE = 'the service is temporarily unavailable. please retry later.'

function isTransientFailure(failure: LlmFailure): boolean {
  return (
    TRANSIENT_CODES.has(failure.code) ||
    (failure.code === 'PI_AI_ERROR' && failure.message.trim().toLowerCase() === OUTAGE_MESSAGE)
  )
}

function transientDelay(failure: LlmFailure, attempts: number): number | undefined {
  const backoff = TRANSIENT_BACKOFF_MS[attempts]
  if (backoff === undefined) return undefined
  const retryAfter = failure.providerRetryAfterMs
  if (retryAfter === undefined || !Number.isFinite(retryAfter)) return backoff
  if (retryAfter > MAX_TRANSIENT_DELAY_MS) return undefined
  return Math.max(backoff, retryAfter)
}

interface RetryChain {
  retryId: string

  attempts: number
}

interface WaitState {
  firstFailureAt: number
  attempts: number
  probes: number

  chains: Map<string, RetryChain>
}

export interface RecoveryConfig extends ScheduleOptions {
  spool?: WaitSpool

  onWaitKept?: (entry: PendingWait) => void

  cancelled?: Set<string>
}

const MAX_TRACKED_STATES = 64

const SLEEP_CHUNK_MS = 2 ** 30

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
      timer = setTimeout(
        () => {
          remaining -= SLEEP_CHUNK_MS
          tick()
        },
        Math.min(remaining, SLEEP_CHUNK_MS),
      )
    }
    function onAbort(): void {
      finish(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    tick()
  })
}

export function registerRecovery(ctx: Context, config: RecoveryConfig): void {
  const spool = config.spool
  const lifetime = new AbortController()
  const states = new Map<string, WaitState>()
  const active = new Set<Promise<unknown>>()

  const stateFor = (sessionId: string, turn: number): WaitState => {
    const key = `${sessionId}#${turn}`
    let state = states.get(key)
    if (state === undefined) {
      for (const other of states.keys()) {
        if (other.startsWith(`${sessionId}#`) && other !== key) states.delete(other)
      }
      while (states.size >= MAX_TRACKED_STATES) {
        const oldest = states.keys().next().value
        if (oldest === undefined) break
        states.delete(oldest)
      }
      state = { firstFailureAt: Date.now(), attempts: 0, probes: 0, chains: new Map() }
      states.set(key, state)
    }
    return state
  }

  const dropState = (sessionId: string, turn: number): void => {
    states.delete(`${sessionId}#${turn}`)
  }

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
      const { agent, turn, step, provider, failure, retryPolicy, signal } = payload
      const quota = QUOTA_CODES.has(failure.code)
      if (
        !quota &&
        (!isTransientFailure(failure) ||
          retryPolicy?.mode === 'always' ||
          retryPolicy?.maxRetries === 0)
      ) {
        return next()
      }
      const fused = AbortSignal.any([signal, lifetime.signal])
      if (fused.aborted) return undefined
      if (!quota) {
        const downstream = await next()
        if (fused.aborted) return undefined
        if (downstream !== undefined) return downstream
      }

      const state = stateFor(agent.session.id, turn)
      const policyKey = quota ? '"auto-continue"' : '"auto-continue-transient"'
      const chainKey = JSON.stringify([step, provider, policyKey])
      let chain = state.chains.get(chainKey)
      if (chain === undefined) {
        chain = { retryId: randomUUID(), attempts: 0 }
        state.chains.set(chainKey, chain)
      }

      if (!quota) {
        const delayMs = transientDelay(failure, chain.attempts)
        if (delayMs === undefined) return undefined
        const retry = ++chain.attempts
        const position = { retryId: chain.retryId, turn, step, retry }
        agent.session.append('llm/retry', {
          ...position,
          provider,
          failure,
          mode: 'normal',
          policyKey,
          maxRetries: TRANSIENT_BACKOFF_MS.length,
          delayMs,
        } satisfies LlmRetryEventData)
        if (!(await cancellableSleep(delayMs, fused))) return undefined
        agent.session.append('llm/retry-started', position)
        return { kind: 'retry' as const }
      }

      const wait = await plan(provider, state)
      if (fused.aborted) return undefined
      if (wait.kind === 'give-up') {
        ctx.logger.warn(
          `auto-continue: giving up on ${failure.code} from "${provider}" — ${wait.reason}`,
        )
        dropState(agent.session.id, turn)
        await spool?.delete(agent.session.id)
        return next()
      }

      state.attempts += 1
      chain.attempts += 1
      const recorded = agent.session.append('llm/retry', {
        retryId: chain.retryId,
        turn,
        step,
        provider,
        mode: 'always',
        policyKey: '"auto-continue"',
        retry: chain.attempts,
        delayMs: wait.delayMs,
        failure,
      })
      ctx.logger.info(
        'auto-continue: %s from "%s" — scheduled retry %d in %d min%s',
        failure.code,
        provider,
        state.attempts,
        Math.round(wait.delayMs / 60000),
        wait.retryAt === undefined
          ? ' (probe)'
          : ` (until ${new Date(wait.retryAt).toISOString()})`,
      )

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
      await spool?.load()
      if (fused.aborted) return undefined
      await spool?.set(entry)

      const slept = await cancellableSleep(wait.delayMs, fused)
      if (slept && config.cancelled?.has(agent.session.id)) {
        config.cancelled.delete(agent.session.id)
        dropState(agent.session.id, turn)
        await spool?.delete(agent.session.id)
        return undefined
      }
      if (!slept) {
        dropState(agent.session.id, turn)

        if (!lifetime.signal.aborted) config.onWaitKept?.(entry)
        return undefined
      }
      await spool?.delete(agent.session.id)
      agent.session.append('llm/retry-started', {
        retryId: chain.retryId,
        turn,
        step,
        retry: chain.attempts,
      })
      return { kind: 'retry' as const }
    })()
    active.add(operation)
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    )
    return operation
  })

  ctx.effect(
    () => async () => {
      disposeListener()
      lifetime.abort(new Error('auto-continue plugin disposed'))
      await Promise.allSettled(active)
    },
    'auto-continue: abort and drain active recovery',
  )
}
