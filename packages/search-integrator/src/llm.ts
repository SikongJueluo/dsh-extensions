/**
 * The auxiliary-model port: one bounded one-shot call at a time.
 *
 * Wrapping `ctx.llm.stream()` here gives the pipeline a seam tests can fake
 * AND a single place that enforces the stream contract: a call succeeded only
 * when a terminal `finish` chunk with `kind === 'stop'` actually arrived. The
 * assembler reports `{kind: 'stop'}` for a stream that ended WITHOUT a finish
 * chunk, so this port tracks finish arrival itself — a terminated-without-
 * finish stream, `error`/`aborted` finish, `max-tokens`, and a thrown adapter
 * are all failures, and partial text is never treated as success (the
 * auto-permit judge's shortcut is deliberately not copied).
 *
 * @module dsh-search-integrator/llm
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { FinishReason, Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The search-integrator's one-shot auxiliary user messages. */
    'search-integrator': {
      readonly kind: 'search-integrator'
    }
  }
}

/** One auxiliary call request. */
export interface LlmCall {
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  readonly sessionId?: SessionId
}

/** Usage snapshot for the audit (disjoint counts as the adapter reports them). */
export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Settled outcome of one auxiliary call; `text` is empty unless `ok`. */
export interface LlmCallOutcome {
  readonly ok: boolean
  readonly text: string
  readonly finishKind: string
  readonly usage?: LlmUsage
  /** Human-readable failure reason when `ok` is false. */
  readonly error?: string
}

/** The port the pipeline consumes. */
export interface LlmPort {
  call(req: LlmCall, signal: AbortSignal): Promise<LlmCallOutcome>
}

function reasonText(reason: FinishReason): string {
  if (reason.kind === 'max-tokens') return 'model hit the output token limit'
  if (reason.kind === 'aborted') return 'model call aborted'
  if (reason.kind === 'error') return reason.failure?.message ?? 'model adapter error'
  if (reason.kind === 'tool-calls') return 'model tried to call tools (not supported here)'
  return `unexpected finish kind: ${reason.kind}`
}

/**
 * The real port over `ctx.llm.stream`.
 *
 * @param ctx - plugin context (for `ctx.llm`).
 * @param route - provider/model/maxTokens from the live settings, plus the
 *   owning session id stamped on every request for routing metadata.
 */
export function createLlmPort(
  ctx: Context,
  route: { provider: string; model: string; maxTokens: number; sessionId?: SessionId },
): LlmPort {
  return {
    async call(req, signal) {
      const sessionId = req.sessionId ?? route.sessionId
      const message: Message = createUserMessage({
        content: [{ type: 'text', text: req.user }],
        source: { kind: 'search-integrator' },
      })
      const assembler = new BlockAssembler()
      let sawFinish = false
      try {
        const stream = ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system: req.system,
          messages: [message],
          maxTokens: req.maxTokens,
          ...(sessionId === undefined ? {} : { sessionId }),
          signal,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'finish') sawFinish = true
          assembler.push(chunk)
        }
        const usage = assembler.usage
        const snapshot = {
          ...(usage === undefined ? {} : {
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          }),
        }
        if (!sawFinish) {
          return { ok: false, text: '', finishKind: 'none', ...snapshot, error: 'stream ended without a finish chunk' }
        }
        const text: string[] = []
        for (const block of assembler.blocks()) {
          if (block.type === 'text') text.push(block.text)
        }
        const finish = assembler.finish
        if (finish.kind !== 'stop') {
          return { ok: false, text: '', finishKind: finish.kind, ...snapshot, error: reasonText(finish) }
        }
        return { ok: true, text: text.join('\n'), finishKind: finish.kind, ...snapshot }
      } catch (error) {
        const aborted = signal.aborted
        return {
          ok: false,
          text: '',
          finishKind: aborted ? 'aborted' : 'error',
          error: aborted ? 'model call aborted' : String(error),
        }
      }
    },
  }
}
