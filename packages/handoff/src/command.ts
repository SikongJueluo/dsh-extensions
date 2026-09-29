/**
 * `/handoff` command registration: confirmation dialog plus the briefing
 * instruction handed to the current agent.
 *
 * @module dsh-handoff/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { COMMAND_NAME, DEFAULT_BRIEF_DIR, PACKAGE_NAME } from './identity.js'
import { briefInstruction, startHandoffWatch, timestampSlug, type HandoffRuntime, type PendingHandoff, type PresetChoice } from './brief.js'

/** Label shown for "keep this session's preset and model". Must match {@link LABEL_DEFAULT} parsing. */
const LABEL_INHERIT = '继承当前会话'
/** Label shown for "same as manually clicking New Session". */
const LABEL_DEFAULT = '全局默认'

/** How long the confirmation card may sit unanswered before we fall back to the default choice. */
const CONFIRM_TIMEOUT_MS = 60_000

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

/** Resolve a {@link PendingHandoff} key for an agent (its session id as a plain string). */
function keyOf(agent: Agent): string {
  return String(agent.id)
}

/**
 * Ask the user which preset/model the new session should use.
 *
 * Returns `'cancel'` when the card fails or is dismissed, `'inherit'` when
 * unanswered past {@link CONFIRM_TIMEOUT_MS} or when no user-questions
 * answerer is composed (headless deployments). The ask deliberately does NOT
 * ride `invocation.signal`: the UI request's lifetime must not cancel an
 * unanswered question — our own timeout is the fallback.
 */
async function askChoice(ctx: Context, agent: Agent): Promise<PresetChoice | 'cancel'> {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return 'inherit'
  try {
    const ask = userQuestions.ask({
      questions: [
        {
          id: 'preset',
          header: 'Handoff',
          question: '新会话使用哪个预设与模型？',
          options: [
            { label: LABEL_INHERIT, description: '沿用本会话的 preset 与 provider/model，交接前后行为一致' },
            { label: LABEL_DEFAULT, description: '与手动新建会话相同：默认 preset + 全局默认模型' },
          ],
        },
      ],
      agent,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS)
    })
    let answer: Awaited<typeof ask> | 'timeout'
    try {
      answer = await Promise.race([ask, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (answer === 'timeout') return 'inherit'
    const selected = answer.answers[0]?.selected[0]
    return selected === LABEL_DEFAULT ? 'default' : 'inherit'
  } catch {
    // Dismissed card, aborted request, or an answerer failure: treat as cancel.
    return 'cancel'
  }
}

/** Build the `/handoff` command definition. */
export function handoffCommandDefinition(rt: HandoffRuntime): CommandDefinition {
  const { ctx, config } = rt
  return {
    name: COMMAND_NAME,
    description: 'summarize this session into a self-contained brief, then start a fresh session on the task',
    input: { hint: '<task description for the next session>' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const agent = invocation.agent
      const task = invocation.rawInput.trim()
      if (task.length === 0) {
        return fail('Usage: /handoff <task description for the next session>')
      }

      const key = keyOf(agent)
      if (rt.pending.has(key)) {
        return fail('A handoff is already in flight for this session; wait for it to finish first.')
      }

      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        return fail('This session records no working directory, so a handoff target workspace is unknown.')
      }

      let choice: PresetChoice
      if (config.confirm !== false) {
        const answer = await askChoice(ctx, agent)
        if (answer === 'cancel') return ok('Handoff cancelled.')
        choice = answer
      } else {
        choice = 'inherit'
      }

      const dir = config.dir?.startsWith('/') === true ? config.dir! : `${cwd}/${config.dir ?? DEFAULT_BRIEF_DIR}`
      const briefPath = `${dir.replace(/\/+$/, '')}/${timestampSlug(new Date())}-handoff.md`

      // Queue the briefing turn on the CURRENT agent. followup parks a normal
      // next-turn message, so a busy agent writes the brief after its current
      // turn finishes.
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: briefInstruction(briefPath, task, rt.maxBriefChars) }],
          source: { kind: 'user' },
        }),
      )

      const pending: PendingHandoff = {
        agent,
        cwd,
        briefPath,
        task,
        choice,
        startedAt: Date.now(),
        stop: () => {},
      }
      rt.pending.set(key, pending)
      startHandoffWatch(rt, pending)

      ctx.logger(PACKAGE_NAME).info('handoff requested', { session: key, briefPath })
      return ok(
        [
          'Handoff started.',
          `- Brief target: \`${briefPath}\``,
          `- Preset/model: ${choice === 'inherit' ? LABEL_INHERIT : LABEL_DEFAULT}`,
          `The new session appears in this workspace's sidebar (title "Handoff: …") once the brief is complete (timeout ${Math.round(rt.timeoutMs / 1000)}s).`,
        ].join('\n'),
      )
    },
  }
}
