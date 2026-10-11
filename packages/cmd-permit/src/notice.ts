/**
 * Human-facing allowlist notices: each auto-allow decision is appended to the
 * requesting session's log as one user-role message whose source carries
 * `form: 'notice'` — the stock Web chat renders its `summary` as a collapsed
 * context row (persistent, replayable), and the one-line account beneath it
 * enters the model transcript (the agent learning that an escalation was
 * allowlisted is cheap and useful). Deferrals produce NO notice here: the
 * next answerer (auto-permit judge / human dialog) already narrates those.
 *
 * @module dsh-cmd-permit/notice
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

// Merge-extensible source registry: give our notice kind a first-class slot
// (runtime consumers read `form`/`summary` duck-typed).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'cmd-permit': {
      kind: 'cmd-permit'
      form: 'notice'
      summary: string
    }
  }
}

/**
 * Build one notice message for an allowlisted escalation.
 *
 * @param command - the command that was auto-allowed (already excerpted).
 * @param mode - the escalation mode that was granted.
 * @param via - the rule that covered the command (name or pattern excerpt).
 * @returns the frozen user-role notice message.
 */
export function buildNoticeMessage(command: string, mode: string, via: string): UserMessage {
  const summary = boundContextSummary(`cmd-permit ✓ allowlisted (${via}): ${command}`)
  const lines = [
    `[cmd-permit] auto-allowed escalation to ${mode}: command matches allowlist entry "${via}"`,
    command,
  ]
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'cmd-permit', form: 'notice', summary },
  })
}
