/**
 * dsh-usage-audit — `/usage-audit`: measure what the models actually cost.
 *
 * Scans the local session event logs (nothing leaves the machine) and
 * reports per-route and per-session cache-hit rates and token usage, so
 * routing choices and cache-affinity changes (e.g. the chatgpt
 * `promptCacheKey` toggle in dsh-oauth-providers) can be judged with data
 * instead of quota-drain anecdotes.
 *
 * @module dsh-usage-audit
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collectAudit, formatReport } from './audit.js'

export { collectAudit, formatReport } from './audit.js'
export type { AuditReport, ModelAggregate, SessionAggregate } from './audit.js'

export const USAGE_AUDIT_COMMAND = 'usage-audit'

interface Config {
  /** Default scan window for `/usage-audit` without arguments (days). */
  days?: number
  /** How many sessions the per-session table lists. */
  sessionLimit?: number
}

// No `Schema<Config>` annotation: see AGENTS.md — the loader validates the
// inferred shape, and an annotation would fight schemastery's generics.
export const Config = Schema.object({
  days: Schema.number().step(1).min(1).max(3650).default(14)
    .description('/usage-audit 不带参数时的默认扫描窗口（天）。'),
  sessionLimit: Schema.number().step(1).min(1).max(100).default(15)
    .description('按会话表格最多列出的会话数。'),
})

/** `$DSH_HOME` (matching dsh-home-paths) over `~/.dsh`. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function parseDays(rawInput: string, fallback: number): { days: number | undefined } | { error: string } {
  const text = rawInput.trim()
  if (text.length === 0) return { days: fallback }
  if (text === 'all' || text === '全部') return { days: undefined }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 1) {
    return { error: `无法识别的参数「${text}」：需要一个天数（如 7），或 all 表示全部历史。` }
  }
  return { days: Math.min(3650, Math.floor(value)) }
}

function usageAuditDefinition(config: Config): CommandDefinition {
  return {
    name: USAGE_AUDIT_COMMAND,
    description: '扫描本地会话日志，输出各路由/会话的缓存命中率与 token 用量（参数：天数，或 all）',
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const parsed = parseDays(invocation.rawInput, config.days ?? 14)
      if ('error' in parsed) return { kind: 'error', text: parsed.error }
      try {
        const home = dshHome()
        const report = await collectAudit(
          join(home, 'sessions'),
          join(home, 'storages', 'session_projcache', 'sessions'),
          {
            days: parsed.days,
            sessionLimit: config.sessionLimit ?? 15,
            now: Date.now(),
          },
        )
        return { kind: 'success', text: formatReport(report) }
      } catch (error) {
        return { kind: 'error', text: `usage-audit 扫描失败：${(error as Error).message}` }
      }
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.logger('usage-audit').info('loaded')
  ctx.inject(['commands'], (svcCtx) => {
    svcCtx.effect(
      () => svcCtx.commands.register(usageAuditDefinition(config)),
      'usage-audit: /usage-audit command',
    )
  })
}
