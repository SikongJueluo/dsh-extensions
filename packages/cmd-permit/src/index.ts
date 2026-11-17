/**
 * dsh-cmd-permit - a deterministic allowlist answerer on the approval waterfall, plus the shared high-risk shape service.
 * @module dsh-cmd-permit
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { collectEvidence, deliverNotice, isHighRisk as builtinHighRisk } from 'dsh-auto-permit'
import type { NoticeAgent } from 'dsh-auto-permit'
import { buildNoticeMessage } from './notice.js'
import { compileRules, decideAllow, isSandboxMode, MODE_RANK } from './rules.js'
import { Config, registerSettings, type CmdPermitSettings } from './settings.js'

export { Config } from './settings.js'
export {
  compileRules,
  decideAllow,
  containsSubstitution,
  MODE_RANK,
  segmentHead,
  splitSegments,
} from './rules.js'
export type { AllowDecision, Compiled, CompiledRules, CompileIssues, SandboxMode } from './rules.js'
export { buildNoticeMessage } from './notice.js'
export type { CmdPermitSettings, MaxMode } from './settings.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cmdPermit?: CmdPermit
  }
}

/** Live session lookup: `agent.session` when materialized, else the store. */
function sessionOf(ctx: Context, agent: { id: SessionId; session?: Session }): Session | undefined {
  const direct = agent.session
  if (direct !== undefined && direct !== null) return direct
  const sessions: unknown = ctx.get('sessions')
  if (sessions instanceof SessionStore) return sessions.get(agent.id)
  return undefined
}

/** The `cmdPermit` service and approval answerer. */
export class CmdPermit extends Service {
  static Config = Config

  private readonly readSettings: () => CmdPermitSettings
  private lastIssuesKey = ''

  constructor(ctx: Context, config: Config) {
    super(ctx, 'cmdPermit')
    this.readSettings = registerSettings(ctx, config)
    this.registerAnswerer(ctx)
  }

  /** The shared high-risk oracle: built-in irreversibility shapes plus this row's denyShape regexes. dsh-auto-permit's judge consults this method when both plugins are mounted, so user additions guard both paths. */
  isHighRisk(command: string): boolean {
    if (builtinHighRisk(command)) return true
    const { denyShapes } = compileRules(this.readSettings())
    return denyShapes.some((re) => re.test(command))
  }

  claim(command: string, mode: string): { via: string } | undefined {
    try {
      const settings = this.readSettings()
      if (!settings.enabled) return undefined
      if (!isSandboxMode(mode)) return undefined
      if (this.isHighRisk(command)) return undefined
      if (MODE_RANK[mode] > MODE_RANK[settings.maxMode]) return undefined
      const rules = compileRules(settings)
      const decision = decideAllow(command, rules)
      if (decision.kind === 'allow') return { via: decision.via }
      return undefined
    } catch {
      return undefined
    }
  }

  /** Warn about invalid regex sources once per distinct set, not per approval. */
  private warnIssues(
    ctx: Context,
    issues: { invalidPatterns: readonly string[]; invalidDenyShapes: readonly string[] },
  ): void {
    const key = JSON.stringify(issues)
    if (key === this.lastIssuesKey) return
    this.lastIssuesKey = key
    if (issues.invalidPatterns.length > 0) {
      ctx.logger.warn(
        'cmd-permit: ignoring invalid allowPattern regexes: %o',
        issues.invalidPatterns,
      )
    }
    if (issues.invalidDenyShapes.length > 0) {
      ctx.logger.warn(
        'cmd-permit: ignoring invalid denyShape regexes: %o',
        issues.invalidDenyShapes,
      )
    }
  }

  /** The deterministic answerer; every surprise falls through to the chain. */
  private registerAnswerer(ctx: Context): void {
    ctx.on(
      'approval/request',
      async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
        try {
          if (req.toolName !== 'bash' || req.callId === undefined) return await next()

          const session = sessionOf(ctx, req.agent)
          if (session === undefined) return await next()
          const agent: NoticeAgent = req.agent

          const evidence = collectEvidence(session, req.callId)
          if (evidence.call === undefined) return await next()

          const mode = evidence.call.sandboxPermissions
          if (mode === undefined) return await next()

          const command = evidence.call.command.slice(0, 160)
          const rules = compileRules(this.readSettings())
          this.warnIssues(ctx, rules.issues)

          if (this.isHighRisk(evidence.call.command)) {
            ctx.logger.info('cmd-permit: high-risk shape, deferring: %s', command)
            return await next()
          }

          const decision = this.claim(evidence.call.command, mode)
          if (decision !== undefined) {
            ctx.logger.info('cmd-permit: allowlisted (%s): %s', decision.via, command)
            notify(ctx, agent, evidence.call.command, mode, decision.via)
            return 'allowed-once'
          }
          return await next()
        } catch (error) {
          ctx.logger.warn('cmd-permit: answerer failed, deferring: %o', error)
          return next()
        }
      },
      true,
    )
  }
}

/** Record the allowlist decision's notice row; never throws. */
function notify(
  ctx: Context,
  agent: NoticeAgent,
  command: string,
  mode: string,
  via: string,
): void {
  deliverNotice(agent, buildNoticeMessage(command.slice(0, 160), mode, via), ctx.logger)
}

export default CmdPermit
