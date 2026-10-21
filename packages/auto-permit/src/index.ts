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
import type { UserMessage } from '@deepseek-ai/dsh-llm'
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
export { judge, buildJudgeMessage, PROMPT_VERSION, SYSTEM_PROMPT } from './judge.js'
export { buildNoticeMessage } from './notice.js'

export const inject = ['llm']

/** Live session lookup: `agent.session` when materialized, else the store. */
function sessionOf(ctx: Context, agent: { id: string }): Session | undefined {
  const direct = (agent as { session?: unknown }).session
  if (direct !== undefined && direct !== null) return direct as Session
  return ctx.get('sessions')?.get(agent.id as never)
}

/**
 * The approval request's agent, narrowed to what the notice path needs: the
 * durable session (audit + fallback) and the host's deferred inbox channel.
 * `inject` is duck-typed because it reached `Agent` after the oldest hosts
 * this plugin still loads on.
 */
export interface NoticeAgent {
  id: string
  session: Session
  inject?(message: UserMessage): void
}

/**
 * Deliver a notice without ever breaking the tool-call/result pairing.
 *
 * An approval is raised from inside the agent loop's `runGroup`, i.e. between
 * the assistant's `tool_calls` (committed as `tool/call` before dispatch) and
 * the `tool/result` batch `commitReady` writes afterwards. A `user/message`
 * appended to the surface at that point lands *between* them, and
 * `deriveMessages()` then projects `assistant(tool_calls) -> user -> tool`,
 * which OpenAI-compatible endpoints reject with HTTP 400 — permanently,
 * because the bad order is durable history. Observed in DSH session
 * 5528dac7 seq 121..129: the auto-permit notice at seq 125 wedged every later
 * request in that session, `/compact` included.
 *
 * `agent.inject()` is the host's own answer for exactly this situation —
 * `ApprovalService.setPolicy()` delivers its mid-turn notices the same way. It
 * queues the message at the `next-step` boundary without waking the driver, so
 * the notice is logged after the tool results and claimed at the start of the
 * next step: same transcript row, correct order.
 *
 * @param agent - the agent whose approval produced the notice.
 * @param message - the built notice message.
 */
export function deliverNotice(agent: NoticeAgent, message: UserMessage): void {
  try {
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return
    }
    // Hosts without the deferred channel: keep the notice, accept the
    // ordering hazard rather than dropping the audit row.
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  } catch {
    // A notice is best-effort observability; the approval outcome itself must
    // not fail because the log rejected the row.
  }
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

/**
 * Record the decision's notice through the order-safe channel.
 *
 * @param agent - the agent the approval was raised for.
 * @param outcome - how the request settled.
 * @param command - the command being escalated (already excerpted).
 * @param reason - the judge's reason line, when the model call produced one.
 */
function notify(
  agent: NoticeAgent,
  outcome: NoticeOutcome,
  command: string,
  reason?: string,
): void {
  deliverNotice(agent, buildNoticeMessage(outcome, command, reason))
}

/**
 * Plugin entry.
 *
 * @param ctx - plugin context.
 * @param config - composition row config (volatile live references).
 */
export function apply(ctx: Context, config: RowConfig): void {
  const readSettings = registerSettings(ctx, config)

  // Per-process, per-session source memory for exact-repeat replay. The
  // audit trail (`approval/decided`) records only the outcome — never WHO
  // decided — so a log-derived "approved before" cannot prove the approval
  // came from the user rather than a plugin auto-answer (e.g. a pre-v3
  // cache-rule allowance). Replay is therefore gated on what this process
  // observed: approvals this plugin ITSELF granted are never replayed
  // (they must stand on their own each time under the current rules);
  // approvals that arrived through `next()` — the human dialog, or another
  // answerer that reconsidered the repeat — may be replayed. A restart
  // empties both sets, so historical approvals fall to the judge/human,
  // never to silent replay.
  const selfAllowed = new Set<string>()
  const chainApproved = new Set<string>()
  const keyOf = (sessionId: string, callId: string): string => `${sessionId}:${callId}`

  ctx.on(
    'approval/request',
    async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      try {
        const settings = readSettings()
        if (!routeConfigured(settings)) return next()
        if (req.toolName !== 'bash' || req.callId === undefined) return next()

        const session = sessionOf(ctx, req.agent)
        if (session === undefined) return next()
        const agent = req.agent as unknown as NoticeAgent
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

        const evidence = collectEvidence(session, req.callId)
        if (evidence.call === undefined) return rest()

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
          notify(agent, 'high-risk', command)
          return rest()
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
          notify(agent, 'allowed-by-cmd-permit', command, claim.via)
          rememberSelf()
          return 'allowed-once'
        }

        // Exact-repeat memory, source-gated: replay only an approval this
        // process saw arrive through the rest of the chain (the human
        // dialog). Our own earlier auto-allowances are deliberately NOT
        // replayable — a pre-v3 cache-rule allowance must not become a
        // standing grant, and post-v3 allowances stand on their own merits
        // each time.
        const replayable = evidence.exactRepeatSources.some(
          (priorCallId) => chainApproved.has(keyOf(session.id, priorCallId))
            && !selfAllowed.has(keyOf(session.id, priorCallId)),
        )
        if (replayable) {
          ctx.logger.info(
            'auto-permit: exact repeat of a chain-approved command, allowing: %s',
            command,
          )
          notify(agent, 'allowed-by-memory', command)
          rememberSelf()
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
          notify(agent, 'allowed', command, result.reason)
          rememberSelf()
          return 'allowed-once'
        }
        ctx.logger.info(
          'auto-permit: judge deferred to human: %s (%s)',
          command,
          result.reason ?? 'no reason recorded',
        )
        notify(agent, 'deferred', command, result.reason)
        return rest()
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
