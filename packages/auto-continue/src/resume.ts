/**
 * Post-restart resumption: the adopter half of auto-continue persistence.
 *
 * On plugin start every spool record is scheduled — a timer until its
 * `retryAt`, then the session is woken with a visible continuation message
 * ("the quota window reset; resume the interrupted turn"). Sessions already
 * live again (restored or opened by the user) are adopted through
 * `agent/created`; sessions that are not are cold-opened through the
 * sessionController's resolve path — the same one the browser uses, so the
 * agent gets its full preset composition back.
 *
 * Guard rails: records past the total wait budget are pruned; a session the
 * user has interacted with since the wait (a user/message event newer than
 * the recorded seq) is left alone; a busy agent is retried later; every
 * fired resumption removes its record, and a quota failure inside the
 * resumed turn re-enters the normal in-memory recovery (which re-persists).
 *
 * @module dsh-auto-continue/resume
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from './shims.js'
import type { PendingWait, WaitSpool } from './spool.js'
import { cancellableSleep } from './recovery.js'
import { buildWaitNotice } from './notice.js'

/** How long to wait before re-checking a busy or unresolvable session. */
export const RETRY_LATER_MS = 60_000

/** Internal control-flow signal: try this record again in a minute. */
class RetryLater extends Error {}

export interface ResumeConfig {
  /** Total wait budget from the first owned failure (ms). */
  maxWaitMs: number
}

/** The visible continuation message sent as the resumed turn's input. */
export function resumeMessage(entry: PendingWait): string {
  return `[auto-continue] The ${entry.provider} ${entry.code} limit that interrupted turn ${entry.turn} has reset. Continue that turn's work from exactly where it stopped.`
}

/** Latest user-authored message seq in the session, or 0 (the "user moved on" probe). */
function lastUserSeq(agent: Agent): number {
  let last = 0
  for (const event of agent.session.ownEvents()) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: unknown } } | null)?.source
    if (source?.kind === 'user' && event.seq > last) last = event.seq
  }
  return last
}

/** Handle for arming resumptions from outside (the recovery owner / commands). */
export interface ResumeHandle {
  /** Arm (or re-arm) one record's resumption timer in this process. */
  schedule(entry: PendingWait): void
  /** Cancel one session's pending resumption; true when a record was dropped. */
  cancel(sessionId: string): Promise<boolean>
}

/**
 * Register the resumption adopter: boot scan + agent/created adoption, both
 * unwound on plugin disposal. Records armed later in this process (a wait
 * whose turn aborted while the plugin kept running) reach the same scheduler
 * through the returned handle.
 */
export function registerResume(ctx: Context, config: ResumeConfig, spool: WaitSpool): ResumeHandle {
  const lifetime = new AbortController()
  const pending = new Map<string, Promise<void>>()
  /** Sessions whose adoption notice was already appended to the log. */
  const noticed = new Set<string>()

  /**
   * Surface one armed record in its session as a collapsed notice row (the
   * auto-permit verdict-notice pattern): appending `user/message` is legal at
   * any time, unlike `llm/retry` events which the persistence reader
   * validates against the open step.
   */
  const notice = (entry: PendingWait, agent: Agent): void => {
    if (noticed.has(entry.sessionId) || entry.retryAt <= Date.now() + 1_000) return
    noticed.add(entry.sessionId)
    try {
      agent.session.append('user/message', buildWaitNotice(entry.provider, entry.code, entry.retryAt), { surfaceOp: 'append' })
    } catch (error) {
      noticed.delete(entry.sessionId)
      ctx.logger.warn('auto-continue: wait notice for "%s" failed: %o', entry.sessionId, error)
    }
  }

  const expired = (entry: PendingWait): boolean => Date.now() - entry.firstFailureAt >= config.maxWaitMs

  const attemptResume = async (entry: PendingWait): Promise<void> => {
    if (expired(entry)) {
      await spool.delete(entry.sessionId)
      ctx.logger.info('auto-continue: pending wait for "%s" is past the budget — dropped', entry.sessionId)
      return
    }

    // Prefer an agent that is already live (restored at boot, or opened by
    // the user); otherwise cold-open the session the same way the browser
    // does, so the preset composition is rebuilt.
    let agent: Agent | undefined = ctx.get('agents')?.get(entry.sessionId as SessionId)
    if (agent === undefined) {
      const controller = ctx.get('sessionController')
      if (controller === undefined) {
        ctx.logger.warn('auto-continue: no sessionController to resume "%s" — retrying later', entry.sessionId)
        throw new RetryLater()
      }
      const result = await controller.agents.resolveAgent(entry.sessionId as SessionId)
      if ('error' in result) {
        await spool.delete(entry.sessionId)
        ctx.logger.warn('auto-continue: cannot resume "%s" (%o) — record dropped', entry.sessionId, result.error)
        return
      }
      agent = result.agent
    }

    if (agent.status !== 'idle') {
      ctx.logger.info('auto-continue: "%s" is busy — retrying in %d ms', entry.sessionId, RETRY_LATER_MS)
      throw new RetryLater()
    }
    // The user has driven this session since our wait began: stand down.
    if (lastUserSeq(agent) > entry.lastSeq) {
      await spool.delete(entry.sessionId)
      ctx.logger.info('auto-continue: "%s" has newer user activity — record dropped', entry.sessionId)
      return
    }

    noticed.delete(entry.sessionId)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: resumeMessage(entry) }],
      source: { kind: 'user' },
    }))
    await spool.delete(entry.sessionId)
    ctx.logger.info(
      'auto-continue: resumed "%s" (turn %d, %s %s) after wait',
      entry.sessionId,
      entry.turn,
      entry.provider,
      entry.code,
    )
  }

  const schedule = (entry: PendingWait): void => {
    if (lifetime.signal.aborted || pending.has(entry.sessionId)) return
    const task = cancellableSleep(Math.max(0, entry.retryAt - Date.now()), lifetime.signal)
      .then(async (slept) => {
        if (!slept) return
        const fresh = spool.get(entry.sessionId)
        if (fresh === undefined) return
        // A newer cycle replaced this wait: follow it instead.
        if (fresh.retryAt !== entry.retryAt) {
          schedule(fresh)
          return
        }
        try {
          await attemptResume(fresh)
        } catch (error) {
          if (error instanceof RetryLater && !expired(fresh)) {
            schedule({ ...fresh, retryAt: Date.now() + RETRY_LATER_MS })
            return
          }
          if (!(error instanceof RetryLater)) {
            ctx.logger.warn('auto-continue: resuming "%s" failed: %o — record kept for the next start', entry.sessionId, error)
          }
        }
      })
      .finally(() => {
        pending.delete(entry.sessionId)
      })
    pending.set(entry.sessionId, task)
  }

  // Boot scan: adopt every persisted wait once the spool is loaded.
  void spool.load().then(async () => {
    await spool.pruneExpired(config.maxWaitMs)
    const registry = ctx.get('agents')
    for (const entry of spool.all()) {
      schedule(entry)
      const live = registry?.get(entry.sessionId as Parameters<typeof registry.get>[0])
      if (live !== undefined) notice(entry, live)
    }
  })

  // Sessions the user (or boot restore) opened after our start: adopt them.
  ctx.on('agent/created', (payload) => {
    const entry = spool.get(payload.agent.session.id)
    if (entry !== undefined) {
      schedule(entry)
      notice(entry, payload.agent)
    }
  })

  ctx.effect(() => async () => {
    lifetime.abort(new Error('auto-continue plugin disposed'))
    await Promise.allSettled([...pending.values()])
  }, 'auto-continue: abort and drain pending resumptions')

  return {
    schedule,
    async cancel(sessionId) {
      noticed.delete(sessionId)
      // The armed timer no-ops at wake when its record is gone.
      if (spool.get(sessionId) === undefined) return false
      await spool.delete(sessionId)
      ctx.logger.info('auto-continue: pending wait for "%s" cancelled', sessionId)
      return true
    },
  }
}
