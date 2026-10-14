/**
 * dsh-cmd-permit — a deterministic allowlist answerer on the approval
 * waterfall, plus the shared high-risk shape service.
 *
 * When a bash sandbox escalation reaches the `approval/request` waterfall
 * (the model retried a denied command with `sandbox_permissions`), this
 * plugin decides it by CONFIG instead of by a model call:
 *
 * 1. high-risk shape → `next()`: the human dialog decides, never a plugin;
 *    the built-in irreversibility table comes from `dsh-auto-permit`
 *    (`isHighRisk`) extended with this row's `denyShape` regexes. The same
 *    union is exposed as the `cmdPermit` service, which a mounted
 *    dsh-auto-permit consults before its judge — so user denyShape entries
 *    guard BOTH paths and the table has exactly one home per kind of rule.
 * 2. every segment of the command covered by `allow` names / `allowPattern`
 *    regexes, and the requested mode ≤ `maxMode` → `allowed-once`, with a
 *    session notice row naming the rule that covered it.
 * 3. anything else — compound commands with an uncovered segment, command
 *    substitution, a wider mode, no recoverable evidence — → `next()`, so
 *    the auto-permit judge (mounted earlier, hence later in the chain) and
 *    then the human answerer see it untouched.
 *
 * Like dsh-auto-permit, this plugin NEVER returns `rejected`: a plugin must
 * not masquerade as the user's explicit "no", and every failure of its own
 * degrades toward the human dialog, never past it.
 *
 * Chain order: both answerers register with `prepend`, so the LAST-mounted
 * plugin runs first. This bundle's row must sit AFTER dsh-auto-permit's row
 * (bundle layers append, which is the natural install order) — then
 * cmd-permit claims allowlisted escalations before the judge model is ever
 * called, and high-risk shapes still defer through the judge's own guard.
 *
 * @module dsh-cmd-permit
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import { collectEvidence, deliverNotice, isHighRisk as builtinHighRisk } from 'dsh-auto-permit'
import type { NoticeAgent } from 'dsh-auto-permit'
import { buildNoticeMessage } from './notice.js'
import { compileRules, decideAllow, MODE_RANK, type SandboxMode } from './rules.js'
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
export type {
  AllowDecision,
  Compiled,
  CompiledRules,
  CompileIssues,
  SandboxMode,
} from './rules.js'
export { buildNoticeMessage } from './notice.js'
export type { CmdPermitSettings, MaxMode } from './settings.js'

// Optional member: the service exists exactly while this plugin is loaded;
// opportunistic consumers use ctx.get('cmdPermit') and handle undefined.
declare module '@deepseek-ai/cordis' {
  interface Context {
    cmdPermit?: CmdPermit
  }
}

/** Live session lookup: `agent.session` when materialized, else the store. */
function sessionOf(ctx: Context, agent: { id: string }): Session | undefined {
  const direct = (agent as { session?: unknown }).session
  if (direct !== undefined && direct !== null) return direct as Session
  return ctx.get('sessions')?.get(agent.id as never)
}

/**
 * The `cmdPermit` service and approval answerer.
 */
export class CmdPermit extends Service {
  static Config = Config

  /** Live settings reader (volatile references; edits apply without remount). */
  private readonly readSettings: () => CmdPermitSettings
  /** Last warned-about invalid regex sources; warn once per change, not per call. */
  private lastIssuesKey = ''

  constructor(ctx: Context, config: Config) {
    super(ctx, 'cmdPermit')
    this.readSettings = registerSettings(ctx, config)
    this.registerAnswerer(ctx)
  }

  /**
   * The shared high-risk oracle: built-in irreversibility shapes plus this
   * row's denyShape regexes. dsh-auto-permit's judge consults this method
   * when both plugins are mounted, so user additions guard both paths.
   */
  isHighRisk(command: string): boolean {
    if (builtinHighRisk(command)) return true
    const { denyShapes } = compileRules(this.readSettings())
    return denyShapes.some((re) => re.test(command))
  }

  /**
   * The shared allowlist decision (best-effort total: never throws). The
   * front-of-chain answerer (dsh-auto-permit — its `inject` starts it late,
   * so its prepended listener reliably leads) calls this between its
   * high-risk guard and its memory/judge paths, which removes any dependence
   * on listener ordering. Returns the covering rule's name, or undefined to
   * leave the request to the rest of the chain.
   */
  claim(command: string, mode: string): { via: string } | undefined {
    try {
      const settings = this.readSettings()
      if (!settings.enabled) return undefined
      if (MODE_RANK[mode as SandboxMode] === undefined) return undefined
      if (this.isHighRisk(command)) return undefined
      if (MODE_RANK[mode as SandboxMode] > MODE_RANK[settings.maxMode]) return undefined
      const rules = compileRules(settings)
      const decision = decideAllow(command, rules)
      if (decision.kind === 'allow') return { via: decision.via }
      return undefined
    } catch {
      // A best-effort oracle must never break the caller's own decision flow.
      return undefined
    }
  }

  /** Warn about invalid regex sources once per distinct set, not per approval. */
  private warnIssues(ctx: Context, issues: { invalidPatterns: readonly string[]; invalidDenyShapes: readonly string[] }): void {
    const key = JSON.stringify(issues)
    if (key === this.lastIssuesKey) return
    this.lastIssuesKey = key
    if (issues.invalidPatterns.length > 0) {
      ctx.logger.warn('cmd-permit: ignoring invalid allowPattern regexes: %o', issues.invalidPatterns)
    }
    if (issues.invalidDenyShapes.length > 0) {
      ctx.logger.warn('cmd-permit: ignoring invalid denyShape regexes: %o', issues.invalidDenyShapes)
    }
  }

  /** The deterministic answerer; every surprise falls through to the chain. */
  private registerAnswerer(ctx: Context): void {
    ctx.on(
      'approval/request',
      async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
        try {
          if (req.toolName !== 'bash' || req.callId === undefined) return next()

          const session = sessionOf(ctx, req.agent)
          if (session === undefined) return next()
          const agent = req.agent as unknown as NoticeAgent

          const evidence = collectEvidence(session, req.callId)
          if (evidence.call === undefined) return next()

          // Only sandbox-escalation retries carry a target mode; plain bash
          // approvals belong to the rest of the chain.
          const mode = evidence.call.sandboxPermissions as SandboxMode | undefined
          if (mode === undefined) return next()

          const command = evidence.call.command.slice(0, 160)
          const rules = compileRules(this.readSettings())
          this.warnIssues(ctx, rules.issues)

          if (this.isHighRisk(evidence.call.command)) {
            ctx.logger.info('cmd-permit: high-risk shape, deferring: %s', command)
            return next()
          }

          const decision = this.claim(evidence.call.command, mode)
          if (decision !== undefined) {
            ctx.logger.info('cmd-permit: allowlisted (%s): %s', decision.via, command)
            notify(agent, evidence.call.command, mode, decision.via)
            return 'allowed-once'
          }
          return next()
        } catch (error) {
          // Any surprise (log read failure, evidence drift, …) goes to the
          // rest of the chain; never claim or reject on our own failure.
          ctx.logger.warn('cmd-permit: answerer failed, deferring: %o', error)
          return next()
        }
      },
      // Prepend: run before the Web GUI answerer. Together with the row
      // order note above, this puts cmd-permit ahead of the auto-permit
      // judge, which is the point: cheap deterministic claims first.
      true,
    )
  }
}

/**
 * Record the allowlist decision's notice row; never throws.
 *
 * Goes through `deliverNotice` for the same reason auto-permit does: this runs
 * inside `approval/request`, i.e. between the assistant's `tool_calls` and the
 * `tool/result` batch, where a surface `user/message` would split the pair and
 * wedge the session on OpenAI-compatible endpoints (see `deliverNotice`).
 */
function notify(agent: NoticeAgent, command: string, mode: string, via: string): void {
  deliverNotice(agent, buildNoticeMessage(command.slice(0, 160), mode, via))
}

export default CmdPermit
