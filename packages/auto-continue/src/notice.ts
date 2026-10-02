/**
 * Human-facing wait notices: when a persisted quota wait is adopted (session
 * opened or restored after a restart), one user-role notice row is appended
 * to the session log — the stock Web chat renders its `summary` as a
 * collapsed context row (the auto-permit verdict-notice precedent).
 *
 * A user/message row is appendable at any time (no turn/step invariant, the
 * permission flow appends mid-step), unlike `llm/retry` events which the
 * persistence reader validates against the open step — appending those
 * outside a live step corrupts the log on the next load.
 *
 * The notice's single text line does enter the model transcript; the agent
 * knowing a retry is pending is cheap (~one line) and useful.
 *
 * @module dsh-auto-continue/notice
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

// Merge-extensible source registry: give our notice kind a first-class slot
// (runtime consumers read `form`/`summary` duck-typed).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'auto-continue': {
      kind: 'auto-continue'
      form: 'notice'
      summary: string
    }
  }
}

/** Format one fire time for both the summary and the body line. */
function fireTime(retryAt: number): string {
  return new Date(retryAt).toLocaleString('zh-CN', { hour12: false })
}

/**
 * Build the adoption notice for one pending wait.
 *
 * @param provider - the provider route that reported the failure.
 * @param code - the failure code being recovered.
 * @param retryAt - epoch ms when the retry fires.
 * @returns the frozen user-role notice message.
 */
export function buildWaitNotice(provider: string, code: string, retryAt: number): UserMessage {
  const when = fireTime(retryAt)
  const summary = boundContextSummary(`auto-continue ⏳ ${provider} ${code} → ${when}`)
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[auto-continue] ${provider} ${code} 限额等待中，将于 ${when} 自动重试；/ac-cancel 可取消，/ac-status 查看状态。`,
    }],
    source: { kind: 'auto-continue', form: 'notice', summary },
  })
}
