/**
 * The brief lifecycle: instruction prompt, completion watching, and the
 * bootstrap prompt for the fresh session.
 *
 * @module dsh-handoff/brief
 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from './index.js'
import { COMPLETE_MARKER, PACKAGE_NAME } from './identity.js'
import type { HandoffChannel } from './channel.js'
import { spawnHandoff } from './spawn.js'

/** Which model route the fresh session should use. */
export type ModelChoice =
  | { kind: 'inherit' }
  | { kind: 'default' }
  | { kind: 'model'; provider: string; model: string; reasoningEffort?: string }

/** One in-flight handoff, keyed by the origin agent's session id. */
export interface PendingHandoff {
  /** The agent (and session) that writes the brief. */
  readonly agent: Agent
  /** Absolute workspace cwd shared by the origin and the fresh session. */
  readonly cwd: string
  /** Absolute path the brief must be written to. */
  readonly briefPath: string
  /** The verbatim task description from the command line. */
  readonly task: string
  /** Model route chosen in the dialog or via --model; preset inheritance follows it. */
  readonly choice: ModelChoice
  /** Epoch milliseconds when the command ran. */
  readonly startedAt: number
  /** Stops the watch (idempotent). Assigned by {@link startHandoffWatch}. */
  stop: () => void
}

/** Per-apply plugin state. */
export interface HandoffRuntime {
  readonly ctx: Context
  readonly config: Config
  /** Resolved config derived once, in chars. */
  readonly maxBriefChars: number
  /** Resolved config derived once, in ms. */
  readonly timeoutMs: number
  /** Resolved config derived once, in ms. */
  readonly pollMs: number
  /** How long the browser's model picker may stay open before the command gives up (ms). */
  readonly pickTimeoutMs: number
  readonly notifyFailure: boolean
  /** In-flight handoffs keyed by origin session id. */
  readonly pending: Map<string, PendingHandoff>
  /** Browser pick channel; absent only when the composition has no connection/web server. */
  readonly channel?: HandoffChannel
}

/** `20260928-153012` style slug for brief file names. */
export function timestampSlug(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** The instruction handed to the CURRENT agent: write the brief, then stop. */
export function briefInstruction(briefPath: string, task: string, maxBriefChars: number): string {
  return [
    `[handoff] /handoff 触发会话交接。本回合唯一任务：写一份交接简报到 ${briefPath}，供下一个没有本会话历史的新会话接手——简报必须自包含。`,
    '',
    'Markdown 六节：',
    '- Goal：本会话总目标',
    '- Current state：进展与工作区现状（已改文件、未完成项）',
    '- Key decisions：关键决策与理由',
    '- Files：关键文件/路径及状态',
    '- Next steps：后续步骤（有序）',
    '- Open questions：待用户确认的事项',
    '',
    '末尾追加原样任务：',
    '',
    '## Task',
    task,
    '',
    `要求：不超过约 ${maxBriefChars} 字符；文件最后一行单独写 ${COMPLETE_MARKER}；写完后只回一行确认，不做其他事。`,
  ].join('\n')
}

/** The first prompt of the fresh session: the brief plus bootstrap guidance. */
export function bootstrapPrompt(pending: PendingHandoff, brief: string): string {
  return [
    `[handoff] 你是新会话，无历史；上一会话的全部上下文在下方简报中（源 ${String(pending.agent.id)}，文件 ${pending.briefPath}）。直接开始执行 Task：按 Next steps 推进；简报与工作区不符时以工作区为准；仅对简报未覆盖且无法查证的信息询问用户。`,
    '',
    '---',
    brief,
    '---',
  ].join('\n')
}

/** Report a failed handoff: log, and optionally a visible notice turn on the origin session. */
function reportFailure(rt: HandoffRuntime, pending: PendingHandoff, reason: string): void {
  rt.ctx.logger(PACKAGE_NAME).warn('handoff failed', { reason, briefPath: pending.briefPath })
  if (rt.notifyFailure) {
    try {
      pending.agent.followup(
        createUserMessage({
          content: [
            {
              type: 'text',
              text: `[handoff] 交接未完成（${reason}）。简报文件（若有）保留在 ${pending.briefPath}，可检查后重新执行 /handoff。`,
            },
          ],
          source: { kind: 'user' },
        }),
      )
    } catch {
      // The origin agent may already be disposed; the log entry above still stands.
    }
  }
}

/**
 * Watch the brief file until the completion marker appears (or the deadline
 * passes), then spawn the fresh session with the brief as its first prompt.
 */
export function startHandoffWatch(rt: HandoffRuntime, pending: PendingHandoff): void {
  const { ctx } = rt
  const key = String(pending.agent.id)
  let settled = false

  const finish = (): void => {
    if (settled) return
    settled = true
    clearInterval(poll)
    clearTimeout(deadline)
    rt.pending.delete(key)
  }

  const poll = setInterval(() => {
    void (async () => {
      if (settled) return
      try {
        const text = await readFile(pending.briefPath, 'utf8')
        if (!text.includes(COMPLETE_MARKER)) return
        finish()
        try {
          await spawnHandoff(rt, pending, text)
        } catch (error) {
          reportFailure(rt, pending, `new session failed: ${String(error)}`)
        }
      } catch {
        // ENOENT / partial write / transient EBUSY — keep polling.
      }
    })()
  }, rt.pollMs)

  const deadline = setTimeout(() => {
    if (settled) return
    finish()
    reportFailure(rt, pending, `brief not completed within ${Math.round(rt.timeoutMs / 1000)}s`)
  }, rt.timeoutMs)

  // Plugin unload cleans any still-running watch; the marker/timeout paths
  // clear the timers themselves via finish().
  ctx.effect(() => () => {
    finish()
  })

  pending.stop = finish
}
