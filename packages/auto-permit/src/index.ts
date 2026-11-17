import type { Context, Logger } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { collectEvidence } from './evidence.js'
import { containerRisk, isMutableFileDependent } from './container.js'
import { errorTag, warnQuietly } from './diagnostics.js'
import { isHighRisk } from './rules.js'
import { judge } from './judge.js'
import { buildNoticeMessage } from './notice.js'
import type { NoticeDetail, NoticeOutcome } from './notice.js'
import { registerSettings, routeConfigured } from './settings.js'
import type { Config as RowConfig } from './settings.js'

export { Config } from './settings.js'
export type { AutoPermitSettings } from './settings.js'
export { collectEvidence } from './evidence.js'
export { containerRisk, isMutableFileDependent, CONTAINER_RISKS } from './container.js'
export { isHighRisk } from './rules.js'
export { judge, buildJudgeMessage, JUDGE_LIMITS, PROMPT_VERSION, SYSTEM_PROMPT } from './judge.js'
export type { JudgeCategory, JudgeResult, Verdict } from './judge.js'
export { buildNoticeMessage } from './notice.js'

export const inject = ['llm']

const keyOf = (sessionId: string, callId: string): string => `${sessionId}:${callId}`

function sessionOf(ctx: Context, agent: { id: SessionId; session?: Session }): Session | undefined {
  const direct = agent.session
  if (direct !== undefined && direct !== null) return direct
  const sessions: unknown = ctx.get('sessions')
  if (sessions instanceof SessionStore) return sessions.get(agent.id)
  return undefined
}

export interface NoticeAgent {
  id: string
  session?: Session | undefined
  inject?(message: UserMessage): void
}

export function deliverNotice(
  agent: NoticeAgent,
  message: UserMessage,
  logger?: Pick<Logger, 'warn'>,
): void {
  try {
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return
    }

    agent.session?.append('user/message', message, { surfaceOp: 'append' })
  } catch (error) {
    warnQuietly(
      logger,
      'auto-permit: notice delivery failed for %s (%s)',
      agent.id,
      errorTag(error),
    )
  }
}

interface CmdPermitLike {
  isHighRisk(command: string): boolean
  claim(command: string, mode: string): { via: string } | undefined
}

function isCmdPermitLike(value: unknown): value is CmdPermitLike {
  if (typeof value !== 'object' || value === null) return false
  return (
    typeof (value as { isHighRisk?: unknown }).isHighRisk === 'function' &&
    typeof (value as { claim?: unknown }).claim === 'function'
  )
}

function cmdPermitOf(value: unknown): CmdPermitLike | undefined {
  if (value === undefined || value === null) return undefined
  if (!isCmdPermitLike(value)) {
    throw new TypeError('cmdPermit.isHighRisk/claim are not functions')
  }
  return value
}

interface WorkingDirectoryLike {
  get(session: Session): string
}

function isWorkingDirectoryLike(value: unknown): value is WorkingDirectoryLike {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { get?: unknown }).get === 'function'
}

function workingDirectoryOf(value: unknown, session: Session): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!isWorkingDirectoryLike(value)) {
    throw new TypeError('workingDirectory.get is not a function')
  }
  return value.get(session)
}

function notify(
  logger: Pick<Logger, 'warn'>,
  agent: NoticeAgent,
  outcome: NoticeOutcome,
  command: string,
  reason?: string,
  detail?: NoticeDetail,
): void {
  deliverNotice(agent, buildNoticeMessage(outcome, command, reason, detail), logger)
}

export function apply(ctx: Context, config: RowConfig): void {
  const readSettings = registerSettings(ctx, config)

  const selfAllowed = new Set<string>()
  const chainApproved = new Set<string>()

  ctx.on(
    'approval/request',
    async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      try {
        const settings = readSettings()
        if (!routeConfigured(settings)) return await next()
        if (req.toolName !== 'bash' || req.callId === undefined) return await next()

        const session = sessionOf(ctx, req.agent)
        if (session === undefined) return await next()
        const agent: NoticeAgent = req.agent
        const recordChain = (outcome: ApprovalOutcome): ApprovalOutcome => {
          if (outcome === 'allowed-once' && req.callId !== undefined) {
            chainApproved.add(keyOf(session.id, req.callId))
          }
          return outcome
        }
        const rest = async (): Promise<ApprovalOutcome> => recordChain(await next())
        const rememberSelf = (): void => {
          if (req.callId !== undefined) selfAllowed.add(keyOf(session.id, req.callId))
        }

        const evidence = collectEvidence(
          session,
          req.callId,
          workingDirectoryOf(ctx.get('workingDirectory'), session),
        )
        if (evidence.call === undefined) return await rest()

        const command = evidence.call.command.slice(0, 160)

        const cmdPermit = cmdPermitOf(ctx.get('cmdPermit'))
        const container = containerRisk(evidence.call.command)
        const highRisk =
          isHighRisk(evidence.call.command) ||
          (cmdPermit?.isHighRisk(evidence.call.command) ?? false)
        if (highRisk) {
          ctx.logger.info(
            'auto-permit: high-risk shape (%s), deferring to human: %s',
            container ?? 'irreversible',
            command,
          )
          notify(
            ctx.logger,
            agent,
            container === undefined ? 'high-risk' : 'container-guard',
            command,
            container,
          )
          return await rest()
        }

        const claim = cmdPermit?.claim(
          evidence.call.command,
          evidence.call.sandboxPermissions ?? '',
        )
        if (claim !== undefined) {
          ctx.logger.info('auto-permit: cmd-permit allowlisted (%s): %s', claim.via, command)
          notify(ctx.logger, agent, 'allowed-by-cmd-permit', command, claim.via)
          rememberSelf()
          return 'allowed-once'
        }

        const replayable = evidence.exactRepeatSources.some(
          (priorCallId) =>
            chainApproved.has(keyOf(session.id, priorCallId)) &&
            !selfAllowed.has(keyOf(session.id, priorCallId)),
        )
        const mutableRepeat = replayable && isMutableFileDependent(evidence.call.command)
        if (mutableRepeat) {
          ctx.logger.info('auto-permit: repeat re-judged (mutable-file dependent): %s', command)
        }
        if (replayable && !mutableRepeat) {
          ctx.logger.info(
            'auto-permit: exact repeat of a chain-approved command, allowing: %s',
            command,
          )
          notify(ctx.logger, agent, 'allowed-by-memory', command)
          rememberSelf()
          return 'allowed-once'
        }

        const result = await judge(ctx, settings, evidence, session.id, req.signal)
        if (result.verdict === 'allow') {
          ctx.logger.info(
            'auto-permit: judge allowed after %d step(s), evidence [%s]: %s',
            result.steps ?? 1,
            (result.evidence ?? []).join(', ') || 'none',
            command,
          )
          notify(ctx.logger, agent, 'allowed', command, result.reason, {
            evidence: result.evidence,
          })
          rememberSelf()
          return 'allowed-once'
        }
        ctx.logger.info(
          'auto-permit: judge deferred to human [%s] after %d step(s), evidence [%s] (%s): %s',
          result.category ?? 'policy',
          result.steps ?? 1,
          (result.evidence ?? []).join(', ') || 'none',
          result.reason ?? 'no reason recorded',
          command,
        )
        notify(ctx.logger, agent, 'deferred', command, result.reason, {
          category: result.category,
          evidence: result.evidence,
        })
        return await rest()
      } catch (error) {
        ctx.logger.warn('auto-permit: answerer failed, deferring: %o', error)
        return next()
      }
    },

    true,
  )
}
