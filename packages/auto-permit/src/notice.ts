import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'auto-permit': {
      kind: 'auto-permit'
      form: 'notice'
      summary: string
    }
  }
}

export type NoticeOutcome =
  | 'allowed'
  | 'allowed-by-memory'
  | 'allowed-by-cmd-permit'
  | 'deferred'
  | 'high-risk'
  | 'container-guard'

const SUMMARY_PREFIX: Record<NoticeOutcome, string> = {
  allowed: 'auto-permit ✓ allowed',
  'allowed-by-memory': 'auto-permit ✓ allowed (seen this session)',
  'allowed-by-cmd-permit': 'cmd-permit ✓ allowlisted',
  deferred: 'auto-permit ✎ deferred to you',
  'high-risk': 'auto-permit ⚠ irreversible shape — needs you',
  'container-guard': 'auto-permit ⚠ container boundary — needs you',
}

const BODY_PREFIX: Record<NoticeOutcome, string> = {
  allowed: '[auto-permit] allowed this escalation to full access',
  'allowed-by-memory':
    '[auto-permit] allowed this escalation (an equivalent command was approved earlier in this session)',
  'allowed-by-cmd-permit': '[cmd-permit via auto-permit] allowed this escalation: allowlist hit',
  deferred: '[auto-permit] deferred this escalation to the user',
  'high-risk': '[auto-permit] routed this escalation to the user: irreversible shape',
  'container-guard': '[auto-permit] routed this container escalation to the user',
}

const REASON_PREFIX: Partial<Record<NoticeOutcome, string>> = {
  'allowed-by-cmd-permit': 'rule',
  'container-guard': 'boundary',
}

export interface NoticeDetail {
  category?: string

  evidence?: readonly string[]
}

export function buildNoticeMessage(
  outcome: NoticeOutcome,
  command: string,
  reason?: string,
  detail?: NoticeDetail,
): UserMessage {
  const summary = boundContextSummary(`${SUMMARY_PREFIX[outcome]}: ${command}`)
  const lines = [`${BODY_PREFIX[outcome]}: ${command}`]
  if (reason !== undefined && reason !== '') {
    const label = REASON_PREFIX[outcome] ?? 'judge'
    const category = detail?.category === undefined ? '' : ` (${detail.category})`
    lines.push(`${label}${category}: ${reason}`)
  } else if (detail?.category !== undefined && detail.category !== 'policy') {
    lines.push(`judge (${detail.category}): no reason recorded`)
  }
  if (detail?.evidence !== undefined && detail.evidence.length > 0) {
    lines.push(`evidence: ${detail.evidence.slice(0, 8).join(', ')}`)
  }
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'auto-permit', form: 'notice', summary },
  })
}
