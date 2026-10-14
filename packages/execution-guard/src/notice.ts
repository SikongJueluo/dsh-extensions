/**
 * The model-visible correction hint this plugin appends: error code plus the
 * expected argument shape. It rides the standard user-message surface with a
 * first-class `execution-guard` source, so the stock Web chat renders the
 * summary as a collapsed row and the transcript stays replayable.
 *
 * The resume comparison notice that used to share this module now lives in
 * `dsh-task-anchor` (same source kind, so existing transcripts keep
 * rendering).
 *
 * @module dsh-execution-guard/notice
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { INVALID_ARGS_CODE } from './preflight.js'

// Merge-extensible source registry (runtime consumers read form/summary
// duck-typed), same pattern as dsh-auto-permit's notices.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'execution-guard': {
      kind: 'execution-guard'
      form: 'notice' | 'hint'
      summary: string
    }
  }
}

/**
 * The agent surface the notice path needs: the durable session (the fallback
 * write) plus the host's deferred inbox channel. `inject` is duck-typed
 * because it reached the host's `Agent` after the oldest builds this plugin
 * still loads on.
 */
export interface NoticeTarget {
  readonly id?: string
  readonly session?: {
    append(type: 'user/message', data: UserMessage, opts: { surfaceOp: 'append' }): unknown
  }
  inject?(message: UserMessage): void
}

/**
 * Deliver a model-visible notice without breaking the tool-call/result pairing.
 *
 * The repeated-failure hint is produced from the `tools/result` observer, which
 * fires per call from inside the agent loop's `runGroup` — for a parallel batch
 * that is *between* two `tool/result` events. A `user/message` appended to the
 * surface there lands after some results but before others, so
 * `deriveMessages()` projects `assistant(tool_calls) -> tool -> user -> tool`
 * and the later call's result is no longer adjacent to its call. OpenAI-
 * compatible endpoints reject that order with HTTP 400, permanently: the bad
 * order is durable history (see dsh-auto-permit's `deliverNotice` for the
 * wedge this caused in DSH session 5528dac7).
 *
 * `agent.inject()` queues the message at the `next-step` boundary without
 * waking the driver — the host's own channel for mid-turn notices
 * (`ApprovalService.setPolicy()` uses it) — so the hint is logged once the
 * batch has committed its results.
 *
 * @param agent - the agent whose tool produced the notice.
 * @param message - the built notice message.
 */
export function deliverNotice(agent: NoticeTarget, message: UserMessage): void {
  try {
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return
    }
    // Hosts without the deferred channel: keep the notice, accept the
    // ordering hazard rather than dropping it.
    agent.session?.append('user/message', message, { surfaceOp: 'append' })
  } catch {
    // A hint is best-effort; the accounting that produced it must not throw
    // into the observer.
  }
}

/**
 * Build the correction hint for a repeated same-shape argument failure.
 *
 * @param tool - the failing tool name.
 * @param shape - the expected-arguments summary from `describeShape`.
 * @returns the frozen user-role hint message.
 */
export function buildHintMessage(tool: string, shape: string): UserMessage {
  const summary = boundContextSummary(`execution-guard: ${INVALID_ARGS_CODE} repeated on ${tool}`)
  const text =
    `[execution-guard] ${tool} failed with ${INVALID_ARGS_CODE} the same way before. ` +
    `Expected arguments — ${shape}. Fix the arguments to this shape; do not retry the identical call.`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'execution-guard', form: 'hint', summary },
  })
}
