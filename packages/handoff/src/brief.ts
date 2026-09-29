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
import { spawnHandoff } from './spawn.js'

/** Which preset/model the fresh session should use. */
export type PresetChoice = 'inherit' | 'default'

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
  /** Preset/model resolution chosen in the confirmation dialog. */
  readonly choice: PresetChoice
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
  readonly notifyFailure: boolean
  /** In-flight handoffs keyed by origin session id. */
  readonly pending: Map<string, PendingHandoff>
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
    '[handoff 指令] 用户刚执行了 /handoff 命令，要求做一次会话交接。你本回合的唯一任务：为本会话写一份交接简报（handoff brief）。它将作为下一个全新会话的唯一上下文——新会话看不到本会话的任何历史，因此简报必须自包含。',
    '',
    '按以下结构组织（用 Markdown）：',
    '# Goal —— 用户在本会话中的总目标',
    '# Current state —— 目前做到哪一步（结合工作区实际状态：已改动/已创建的文件、未完成的工作）',
    '# Key decisions —— 已做出的关键决策及理由',
    '# Important files & paths —— 相关文件、路径及其当前状态',
    '# Next steps —— 建议的后续步骤（有序列表）',
    '# Open questions —— 未决问题与需要用户确认的事项',
    '',
    '## Task（原样转交给新会话）',
    task,
    '',
    '硬性要求：',
    `1. 简报总长度不超过约 ${maxBriefChars} 个字符；宁可精炼，不要省略关键状态。`,
    `2. 用文件写入工具把简报写入：${briefPath}`,
    `3. 文件的最后一行必须单独一行写：${COMPLETE_MARKER}`,
    '4. 写完后只回复一行确认（例如「handoff brief 已写入」），不要做其他事。',
  ].join('\n')
}

/** The first prompt of the fresh session: the brief plus bootstrap guidance. */
export function bootstrapPrompt(pending: PendingHandoff, brief: string): string {
  return [
    '[handoff 交接] 你是通过 dsh-handoff 插件启动的新会话。上一个会话把它的上下文浓缩成了下面的交接简报，这是你唯一的历史；请优先依据简报和当前工作区的实际状态工作。',
    '',
    `（来源会话 ${String(pending.agent.id)}；简报文件 ${pending.briefPath}）`,
    '',
    '---',
    brief,
    '---',
    '',
    '请阅读简报后直接开始执行「Task」部分：按 Next steps 推进；发现简报与工作区实际状态不符时以实际状态为准；遇到简报未覆盖且无法自行查证的信息再询问用户。',
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
