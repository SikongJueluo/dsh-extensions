/** @module dsh-execution-guard/notice */
import type { Logger } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { GUARD_NAME, INVALID_ARGS_CODE } from './preflight.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'execution-guard': {
      kind: 'execution-guard'
      form: 'notice' | 'hint'
      summary: string
    }
  }
}

/** The agent surface the notice path needs: the durable session (the fallback write) plus the host's deferred inbox channel. `inject` is duck-typed because it reached the host's `Agent` after the oldest builds this plugin still loads on. */
export interface NoticeTarget {
  readonly id?: string
  readonly session?: {
    append(type: 'user/message', data: UserMessage, opts: { surfaceOp: 'append' }): unknown
  }
  inject?(message: UserMessage): void
}

/**
 * Deliver a model-visible notice without breaking the tool-call/result pairing.
 * @param agent - the agent whose tool produced the notice.
 * @param message - the built notice message.
 * @param logger - optional sink for a failed delivery.
 */
export function deliverNotice(
  agent: NoticeTarget,
  message: UserMessage,
  logger?: Pick<Logger, 'warn'>,
): void {
  try {
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return
    }
    agent.session?.append('user/message', message, { surfaceOp: 'append' })
  } catch (error) {
    warnQuietly(
      logger,
      '%s: notice delivery failed for %s (%s)',
      GUARD_NAME,
      agent.id ?? 'unknown',
      error instanceof Error ? error.name : 'non-error',
    )
  }
}

function warnQuietly(
  logger: Pick<Logger, 'warn'> | undefined,
  format: string,
  ...args: unknown[]
): boolean {
  try {
    logger?.warn(format, ...args)
    return true
  } catch {
    return false
  }
}

/**
 * Build the correction hint for a repeated same-shape argument failure.
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
