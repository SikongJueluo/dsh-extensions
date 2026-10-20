/**
 * The `trigger_signal` model tool: the ONLY way a loop participant moves the
 * loop. Plain replies never advance anything.
 *
 * Identity comes from the execution context (`exec.agent`), never from model
 * arguments; a successful call ends the caller's turn (`concludeTurn`), so
 * the signal is always the session's last word and the loop advances only
 * after the normal `turn/end`.
 *
 * @module dsh-triggers/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { SIGNAL_OUTCOMES } from './model.js'
import { TOOL_NAME } from './identity.js'
import type { TriggerService } from './service.js'

const SIGNAL_TOOL_DESCRIPTION = [
  'Submit the structured verdict for an execute-review trigger loop you are taking part in, as the final action of your turn.',
  'The runId and your role (executor or reviewer) come from the [triggers] instructions you received; the loop advances only after this turn ends normally.',
  'The executor submits "deliver" when the round\'s work is done (summary: what changed, how it was verified — tests/build runs and their outcomes — and where the evidence lives) or "needs_user" when a user decision blocks progress.',
  'The reviewer submits "rework" (summary: only findings that block this round\'s goal, each with evidence or reproduction steps; non-blocking notes are recorded and passed), "pass", or "needs_user".',
  'A reply without this tool call never advances the loop.',
].join(' ')

const SUMMARY_PARAMETER_DESCRIPTION = 'The counterpart-facing summary. deliver: what changed, how it was verified (which tests/builds ran and their outcomes), and evidence pointers. rework: the blocking findings only, each with concrete evidence or reproduction steps. needs_user: the exact decision you need, with the options. Never paste full logs — reference them.'

/** Install the tool against the trigger service. Returns the disposer. */
export function registerSignalTool(ctx: Context, service: TriggerService): () => void {
  return ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: SIGNAL_TOOL_DESCRIPTION,
    parameters: {
      runId: {
        type: 'string',
        required: true,
        description: 'The runId from the [triggers] instructions delivered to you.',
      },
      outcome: {
        type: 'string',
        enum: [...SIGNAL_OUTCOMES],
        required: true,
        description: 'deliver (executor: round complete), rework (reviewer: blocking findings), pass (reviewer: accepted), needs_user (either: a user decision is required).',
      },
      summary: {
        type: 'string',
        required: true,
        description: SUMMARY_PARAMETER_DESCRIPTION,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'accepted' },
          note: { type: 'string', required: true },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('trigger_signal 需要在会话中调用（缺少执行代理身份）。')
      const outcome = await service.signal(String(agent.id), args as { runId: unknown, outcome: unknown, summary: unknown })
      if (!outcome.ok) throw new Error(outcome.error)
      // The signal is this turn's last word: end it after the result lands.
      exec.concludeTurn()
      return { kind: 'accepted' as const, note: outcome.note }
    },
  }))
}
