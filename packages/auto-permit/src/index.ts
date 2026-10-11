/**
 * dsh-auto-permit — an AI answerer on the approval waterfall.
 *
 * When a bash sandbox escalation (or any bash approval) reaches the
 * `approval/request` waterfall, this plugin runs BEFORE the Web GUI answerer
 * (registered with `prepend`) and decides whether the request matches what
 * the user already asked for — or already approved — in this session:
 *
 * 1. exact-repeat memory: the same command escalated to the same mode was
 *    already allowed in this session → allowed at once, no model call;
 * 2. high-risk irreversibility shapes (rm -rf ~, git clean -xfd, reset
 *    --hard, push --force, sudo, curl|sh…) → straight to the human dialog;
 * 3. otherwise one bounded one-shot judge call (a small model configured in
 *    the plugin row config) over the session's user prompts, the pending
 *    call's full arguments, and the already-approved commands: ALLOW claims
 *    the request, everything else — ambiguity, timeout, parse failure —
 *    falls through to the human answerer.
 *
 * Every decision is appended to the session's log as a `form: 'notice'`
 * message, so the stock Web chat shows it as a collapsed context row
 * (persistent, replayable; the one-line account also enters the model
 * transcript). The plugin never returns `rejected`: an AI denial must not
 * masquerade as the user's explicit "no". Fail-open direction is toward the
 * human dialog, so a broken judge degrades to the stock behavior, never
 * worse.
 *
 * Consumed host services: `llm` (injected); `sessions` opportunistically
 * via `ctx.get()`.
 *
 * @module dsh-auto-permit
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import { collectEvidence } from './evidence.js'
import { isHighRisk } from './rules.js'
import { judge } from './judge.js'
import { buildNoticeMessage } from './notice.js'
import type { NoticeOutcome } from './notice.js'
import { registerSettings, routeConfigured } from './settings.js'
import type { Config as RowConfig } from './settings.js'

export { Config } from './settings.js'
export type { AutoPermitSettings } from './settings.js'
export { collectEvidence } from './evidence.js'
export { isHighRisk } from './rules.js'
export { judge, buildJudgeMessage, PROMPT_VERSION } from './judge.js'
export { buildNoticeMessage } from './notice.js'

export const inject = ['llm']

/** Live session lookup: `agent.session` when materialized, else the store. */
function sessionOf(ctx: Context, agent: { id: string }): Session | undefined {
  const direct = (agent as { session?: unknown }).session
  if (direct !== undefined && direct !== null) return direct as Session
  return ctx.get('sessions')?.get(agent.id as never)
}

/**
 * The optional dsh-cmd-permit service (the shared high-risk oracle), when
 * that plugin is mounted. Duck-typed on purpose: no packaging dependency in
 * this direction, so auto-permit stays independently installable.
 */
interface CmdPermitLike {
  isHighRisk(command: string): boolean
  claim(command: string, mode: string): { via: string } | undefined
}

/** Append the decision's notice row to the session log; never throws into the caller. */
function notify(session: Session, outcome: NoticeOutcome, command: string, reason?: string): void {
  try {
    session.append('user/message', buildNoticeMessage(outcome, command, reason), {
      surfaceOp: 'append',
    })
  } catch {
    // A notice is best-effort observability; the approval outcome itself
    // must not fail because the log rejected the row.
  }
}

/**
 * Plugin entry.
 *
 * @param ctx - plugin context.
 * @param config - composition row config (volatile live references).
 */
export function apply(ctx: Context, config: RowConfig): void {
  const readSettings = registerSettings(ctx, config)

  ctx.on(
    'approval/request',
    async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      try {
        const settings = readSettings()
        if (!routeConfigured(settings)) return next()
        if (req.toolName !== 'bash' || req.callId === undefined) return next()

        const session = sessionOf(ctx, req.agent)
        if (session === undefined) return next()

        const evidence = collectEvidence(session, req.callId)
        if (evidence.call === undefined) return next()

        const command = evidence.call.command.slice(0, 160)

        // Shared high-risk oracle: when dsh-cmd-permit is mounted, its table
        // (these built-ins plus its row's denyShape regexes) is authoritative,
        // so the judge and the allowlist defer on exactly the same shapes.
        const cmdPermit = ctx.get('cmdPermit') as CmdPermitLike | undefined
        const highRisk = cmdPermit?.isHighRisk(evidence.call.command)
          ?? isHighRisk(evidence.call.command)
        if (highRisk) {
          ctx.logger.info(
            'auto-permit: high-risk shape, deferring to human: %s',
            command,
          )
          notify(session, 'high-risk', command)
          return next()
        }

        // Shared allowlist decision, BEFORE memory and judge: the allowlist
        // is the user's explicit statement of trust, cheaper and stronger
        // than either. Fronting it here (instead of racing a second answerer
        // for chain order) is deliberate — dsh-cmd-permit's own answerer
        // still exists for compositions without this plugin, but with it
        // mounted the order [high-risk → allowlist → memory → judge] holds
        // regardless of listener registration order.
        const claim = cmdPermit?.claim(
          evidence.call.command,
          evidence.call.sandboxPermissions ?? '',
        )
        if (claim !== undefined) {
          ctx.logger.info(
            'auto-permit: cmd-permit allowlisted (%s): %s',
            claim.via,
            command,
          )
          notify(session, 'allowed-by-cmd-permit', command, claim.via)
          return 'allowed-once'
        }

        if (evidence.exactRepeat) {
          ctx.logger.info(
            'auto-permit: exact repeat of an allowed command, allowing: %s',
            command,
          )
          notify(session, 'allowed-by-memory', command)
          return 'allowed-once'
        }

        const result = await judge(
          ctx,
          settings,
          evidence,
          session.id,
          req.signal,
        )
        if (result.verdict === 'allow') {
          ctx.logger.info(
            'auto-permit: judge allowed: %s',
            command,
          )
          notify(session, 'allowed', command, result.reason)
          return 'allowed-once'
        }
        ctx.logger.info(
          'auto-permit: judge deferred to human: %s (%s)',
          command,
          result.reason ?? 'no reason recorded',
        )
        notify(session, 'deferred', command, result.reason)
        return next()
      } catch (error) {
        // Any surprise (log read failure, agent shape drift, …) goes to the
        // human dialog; never reject on the judge's behalf.
        ctx.logger.warn('auto-permit: answerer failed, deferring: %o', error)
        return next()
      }
    },
    // Prepend: run before the Web GUI answerer, which otherwise claims the
    // request first whenever a browser is attached.
    true,
  )
}
