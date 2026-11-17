/** @module dsh-cmd-permit/notice */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

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
