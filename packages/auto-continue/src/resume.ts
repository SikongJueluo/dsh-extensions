import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from './shims.js'
import type { PendingWait, WaitSpool } from './spool.js'
import { cancellableSleep } from './recovery.js'
import { buildWaitNotice } from './notice.js'

export const RETRY_LATER_MS = 60_000

class RetryLater extends Error {}

export interface ResumeConfig {
  maxWaitMs: number
}

export function resumeMessage(entry: PendingWait): string {
  return `[auto-continue] The ${entry.provider} ${entry.code} limit that interrupted turn ${entry.turn} has reset. Continue that turn's work from exactly where it stopped.`
}

function lastUserSeq(agent: Agent): number {
  let last = 0
  // oxlint-disable-next-line typescript/no-deprecated -- A25: the deprecated synchronous session-log readers have no sync replacement; the sanctioned ones are async and optional, so migrating changes exported contracts and control flow.
  for (const event of agent.session.ownEvents()) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source?.kind === 'user' && event.seq > last) last = event.seq
  }
  return last
}

export interface ResumeHandle {
  schedule(entry: PendingWait): void

  cancel(sessionId: string): Promise<boolean>
}

export function registerResume(ctx: Context, config: ResumeConfig, spool: WaitSpool): ResumeHandle {
  const lifetime = new AbortController()
  const pending = new Map<string, Promise<void>>()

  const noticed = new Set<string>()

  const notice = (entry: PendingWait, agent: Agent): void => {
    if (noticed.has(entry.sessionId) || entry.retryAt <= Date.now() + 1_000) return
    noticed.add(entry.sessionId)
    try {
      agent.session.append(
        'user/message',
        buildWaitNotice(entry.provider, entry.code, entry.retryAt),
        { surfaceOp: 'append' },
      )
    } catch (error) {
      noticed.delete(entry.sessionId)
      ctx.logger.warn('auto-continue: wait notice for "%s" failed: %o', entry.sessionId, error)
    }
  }

  const expired = (entry: PendingWait): boolean =>
    Date.now() - entry.firstFailureAt >= config.maxWaitMs

  const attemptResume = async (entry: PendingWait): Promise<void> => {
    if (expired(entry)) {
      await spool.delete(entry.sessionId)
      ctx.logger.info(
        'auto-continue: pending wait for "%s" is past the budget — dropped',
        entry.sessionId,
      )
      return
    }

    const registry: AgentRegistry | undefined = ctx.get('agents')
    let agent: Agent | undefined = registry?.get(SessionId(entry.sessionId))
    if (agent === undefined) {
      const controller = ctx.get('sessionController')
      if (controller === undefined) {
        ctx.logger.warn(
          'auto-continue: no sessionController to resume "%s" — retrying later',
          entry.sessionId,
        )
        throw new RetryLater()
      }
      const result = await controller.agents.resolveAgent(SessionId(entry.sessionId))
      if ('error' in result) {
        await spool.delete(entry.sessionId)
        ctx.logger.warn(
          'auto-continue: cannot resume "%s" (%o) — record dropped',
          entry.sessionId,
          result.error,
        )
        return
      }
      agent = result.agent
    }

    if (agent.status !== 'idle') {
      ctx.logger.info(
        'auto-continue: "%s" is busy — retrying in %d ms',
        entry.sessionId,
        RETRY_LATER_MS,
      )
      throw new RetryLater()
    }

    if (lastUserSeq(agent) > entry.lastSeq) {
      await spool.delete(entry.sessionId)
      ctx.logger.info(
        'auto-continue: "%s" has newer user activity — record dropped',
        entry.sessionId,
      )
      return
    }

    noticed.delete(entry.sessionId)
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: resumeMessage(entry) }],
        source: { kind: 'user' },
      }),
    )
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
        if (!slept) return undefined
        const fresh = spool.get(entry.sessionId)
        if (fresh === undefined) return undefined

        if (fresh.retryAt !== entry.retryAt) {
          schedule(fresh)
          return undefined
        }
        try {
          await attemptResume(fresh)
        } catch (error) {
          if (error instanceof RetryLater && !expired(fresh)) {
            schedule({ ...fresh, retryAt: Date.now() + RETRY_LATER_MS })
            return undefined
          }
          if (!(error instanceof RetryLater)) {
            ctx.logger.warn(
              'auto-continue: resuming "%s" failed: %o — record kept for the next start',
              entry.sessionId,
              error,
            )
          }
        }
        return undefined
      })
      .finally(() => {
        pending.delete(entry.sessionId)
      })
    pending.set(entry.sessionId, task)
  }

  void spool.load().then(async () => {
    await spool.pruneExpired(config.maxWaitMs)
    const registry: AgentRegistry | undefined = ctx.get('agents')
    for (const entry of spool.all()) {
      schedule(entry)
      const live = registry?.get(SessionId(entry.sessionId))
      if (live !== undefined) notice(entry, live)
    }
    return undefined
  })

  ctx.on('agent/created', (payload) => {
    const entry = spool.get(payload.agent.session.id)
    if (entry !== undefined) {
      schedule(entry)
      notice(entry, payload.agent)
    }
  })

  ctx.effect(
    () => async () => {
      lifetime.abort(new Error('auto-continue plugin disposed'))
      await Promise.allSettled(pending.values())
    },
    'auto-continue: abort and drain pending resumptions',
  )

  return {
    schedule,
    async cancel(sessionId) {
      noticed.delete(sessionId)

      if (spool.get(sessionId) === undefined) return false
      await spool.delete(sessionId)
      ctx.logger.info('auto-continue: pending wait for "%s" cancelled', sessionId)
      return true
    },
  }
}
