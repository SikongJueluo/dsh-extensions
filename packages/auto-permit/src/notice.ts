/**
 * Human-facing verdict notices: each judge decision is appended to the
 * requesting session's log as one user-role message whose source carries
 * `form: 'notice'` — the stock Web chat renders its `summary` as a collapsed
 * context row (persistent, replayable, no expansion needed), with the
 * one-line account beneath it.
 *
 * The notice's single text line does enter the model transcript (the
 * `model-selection` notice precedent): the agent learning that an escalation
 * was allowed or deferred is cheap (~one line) and useful. There is no
 * third-party channel into the chat flow that skips the transcript entirely.
 *
 * @module dsh-auto-permit/notice
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

// Merge-extensible source registry: give our notice kind a first-class slot
// (runtime consumers read `form`/`summary` duck-typed).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'auto-permit': {
      kind: 'auto-permit'
      form: 'notice'
      summary: string
    }
  }
}

/** Why the request settled the way it did (mirrors the feed vocabulary). */
export type NoticeOutcome =
  | 'allowed'
  | 'allowed-by-memory'
  | 'deferred'
  | 'high-risk'

const SUMMARY_PREFIX: Record<NoticeOutcome, string> = {
  allowed: 'auto-permit ✓ allowed',
  'allowed-by-memory': 'auto-permit ✓ allowed (seen this session)',
  deferred: 'auto-permit ✎ deferred to you',
  'high-risk': 'auto-permit ⚠ irreversible shape — needs you',
}

const BODY_PREFIX: Record<NoticeOutcome, string> = {
  allowed: '[auto-permit] allowed this escalation to full access',
  'allowed-by-memory': '[auto-permit] allowed this escalation (an equivalent command was approved earlier in this session)',
  deferred: '[auto-permit] deferred this escalation to the user',
  'high-risk': '[auto-permit] routed this escalation to the user: irreversible shape',
}

/**
 * Build one notice message for a settled approval request.
 *
 * @param outcome - how the request settled.
 * @param command - the command being escalated (already excerpted).
 * @param reason - the judge's reason line, when the model call produced one.
 * @returns the frozen user-role notice message.
 */
export function buildNoticeMessage(
  outcome: NoticeOutcome,
  command: string,
  reason?: string,
): UserMessage {
  const summary = boundContextSummary(`${SUMMARY_PREFIX[outcome]}: ${command}`)
  const lines = [`${BODY_PREFIX[outcome]}: ${command}`]
  if (reason !== undefined && reason !== '') lines.push(`judge: ${reason}`)
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'auto-permit', form: 'notice', summary },
  })
}
