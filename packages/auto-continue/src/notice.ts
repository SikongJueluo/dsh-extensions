import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'auto-continue': {
      kind: 'auto-continue'
      form: 'notice'
      summary: string
    }
  }
}

function fireTime(retryAt: number): string {
  return new Date(retryAt).toLocaleString('zh-CN', { hour12: false })
}

export function buildWaitNotice(provider: string, code: string, retryAt: number): UserMessage {
  const when = fireTime(retryAt)
  const summary = boundContextSummary(`auto-continue ⏳ ${provider} ${code} → ${when}`)
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: `[auto-continue] ${provider} ${code} 限额等待中，将于 ${when} 自动重试；/ac-cancel 可取消，/ac-status 查看状态。`,
      },
    ],
    source: { kind: 'auto-continue', form: 'notice', summary },
  })
}
