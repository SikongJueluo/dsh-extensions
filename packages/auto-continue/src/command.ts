/**
 * `/ac-cancel` and `/ac-status`: the operator's window into auto-continue.
 *
 * `/ac-status` reports the current session's pending wait (provider, fire
 * time); `/ac-cancel` stands it down — dropping the persisted record, the
 * armed resumption timer, and any in-flight recovery sleep — so "keep
 * waiting" stays a choice rather than a commitment.
 *
 * @module dsh-auto-continue/command
 */
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ResumeHandle } from './resume.js'
import type { WaitSpool } from './spool.js'

export const CANCEL_COMMAND = 'ac-cancel'
export const STATUS_COMMAND = 'ac-status'

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

function fireTime(retryAt: number): string {
  return new Date(retryAt).toLocaleString('zh-CN', { hour12: false })
}

/** `/ac-cancel` — stand the current session's auto-continue wait down. */
function cancelDefinition(adopter: ResumeHandle, spool: WaitSpool, cancelled: Set<string>): CommandDefinition {
  return {
    name: CANCEL_COMMAND,
    description: '取消当前会话等待中的 auto-continue 自动续跑',
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const sessionId = String(invocation.agent.id)
      const entry = spool.get(sessionId)
      const dropped = await adopter.cancel(sessionId)
      if (entry === undefined && !dropped) return fail('当前会话没有等待中的 auto-continue。')
      // Also disarm an in-flight in-process recovery sleep (open-turn wait).
      cancelled.add(sessionId)
      return ok(`已取消：${entry?.provider ?? 'provider'} 的等待已解除，到达重置时间后不再自动续跑。`)
    },
  }
}

/** `/ac-status` — report the current session's pending wait. */
function statusDefinition(spool: WaitSpool): CommandDefinition {
  return {
    name: STATUS_COMMAND,
    description: '查看当前会话的 auto-continue 等待状态',
    handler(invocation: CommandInvocation): CommandResult {
      const entry = spool.get(String(invocation.agent.id))
      if (entry === undefined) return ok('当前会话没有等待中的 auto-continue。')
      const minutes = Math.max(0, Math.round((entry.retryAt - Date.now()) / 60_000))
      return ok(
        `等待中：${entry.provider} ${entry.code}（第 ${entry.attempts} 次尝试），将于 ${fireTime(entry.retryAt)}（约 ${minutes} 分钟后）自动续跑。可用 /ac-cancel 取消。`,
      )
    },
  }
}

/** Register both commands once the host command registry exists. */
export function registerCommands(
  ctx: import('@deepseek-ai/cordis').Context,
  deps: { adopter: ResumeHandle; spool: WaitSpool; cancelled: Set<string> },
): void {
  ctx.inject(['commands'], (svcCtx) => {
    svcCtx.effect(
      () => svcCtx.commands.register(cancelDefinition(deps.adopter, deps.spool, deps.cancelled)),
      'auto-continue: /ac-cancel command',
    )
    svcCtx.effect(
      () => svcCtx.commands.register(statusDefinition(deps.spool)),
      'auto-continue: /ac-status command',
    )
  })
}
