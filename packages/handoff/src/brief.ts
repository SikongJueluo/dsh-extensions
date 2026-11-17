/**
 * The brief lifecycle: the instruction prompt, completion watching, and the failure report for the origin session.
 * @module dsh-handoff/brief
 */
import { readFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { debugQuietly, errorTag, warnQuietly } from './diagnostics.js'
import { COMPLETE_MARKER, PACKAGE_NAME } from './identity.js'
import type { HandoffRuntime, PendingHandoff } from './pending.js'
import { spawnHandoff } from './spawn.js'

/** Two-digit zero-padded form of one timestamp field. */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `20260928-153012` style slug for brief file names. */
export function timestampSlug(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

const BRIEF_SECTIONS = [
  'Markdown 六节：',
  '- Goal：本会话总目标',
  '- Current state：进展与工作区现状（已改文件、未完成项）',
  '- Key decisions：关键决策与理由',
  '- Files：关键文件/路径及状态',
  '- Next steps：后续步骤（有序）',
  '- Open questions：待用户确认的事项',
]

/** The closing requirements shared by both instruction variants. */
function instructionTail(task: string, maxBriefChars: number): string[] {
  return [
    '',
    '末尾追加原样任务：',
    '',
    '## Task',
    task,
    '',
    `要求：不超过约 ${maxBriefChars} 字符；文件最后一行单独写 ${COMPLETE_MARKER}；写完后只回一行确认，不做其他事。`,
  ]
}

/** The cross-workspace caution shared by both instruction variants. */
function crossNoteFor(cross: { title: string } | undefined): string[] {
  return cross === undefined
    ? []
    : [
        '',
        `注意：本次交接目标是另一个工作区（${cross.title}）。后继会话对上文路径只读、且其来源分支工作区日后可能被清理，关键文件内容请直接摘录进简报而非只给路径。`,
      ]
}

/** The instruction handed to the CURRENT agent: write the brief, then stop. */
export function briefInstruction(
  briefPath: string,
  task: string,
  maxBriefChars: number,
  cross?: { title: string },
): string {
  return [
    `[handoff] /handoff 触发会话交接。本回合唯一任务：写一份交接简报到 ${briefPath}，供下一个没有本会话历史的新会话接手——简报必须自包含。`,
    '',
    ...BRIEF_SECTIONS,
    ...crossNoteFor(cross),
    ...instructionTail(task, maxBriefChars),
  ].join('\n')
}

/** The instruction handed to the CURRENT agent on a retry whose brief file already exists but never reached the completion marker: keep what is written, complete the rest, same file. */
export function continueInstruction(
  briefPath: string,
  task: string,
  maxBriefChars: number,
  cross?: { title: string },
): string {
  return [
    `[handoff] /handoff 重试：交接简报已部分写于 ${briefPath}（上次超时未完成）。本回合唯一任务：读取该文件，在已有内容基础上补完——已写且仍准确的各节保留原样，只补齐缺失或过时的部分。`,
    '',
    ...BRIEF_SECTIONS,
    ...crossNoteFor(cross),
    ...instructionTail(task, maxBriefChars),
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
              text: `[handoff] 交接未完成（${reason}）。简报文件（若有）保留在 ${pending.briefPath}。重试请执行不带参数的 /handoff（或 /handoff --retry）：已写内容会保留并继续补完。`,
            },
          ],
          source: { kind: 'user' },
        }),
      )
    } catch (error) {
      warnQuietly(
        rt.ctx.logger(PACKAGE_NAME),
        'handoff failure notice not delivered for %s (%s)',
        pending.briefPath,
        errorTag(error),
      )
    }
  }
}

/** Watch the brief file until the completion marker appears (or the deadline passes), then spawn the fresh session with the brief as its first prompt. */
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
      } catch (error) {
        debugQuietly(
          ctx.logger(PACKAGE_NAME),
          'handoff brief poll read failed for %s (%s)',
          pending.briefPath,
          errorTag(error),
        )
      }
    })()
  }, rt.pollMs)

  const deadline = setTimeout(() => {
    if (settled) return
    finish()
    reportFailure(rt, pending, `brief not completed within ${Math.round(rt.timeoutMs / 1000)}s`)
  }, rt.timeoutMs)

  ctx.effect(() => () => {
    finish()
  })

  pending.stop = finish
}
