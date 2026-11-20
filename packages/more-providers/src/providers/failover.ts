/**
 * Account failover for pooled routes: every attempt runs under one pool account and a
 * failure before the first forwarded chunk moves the request to the next account.
 * @module dsh-more-providers/providers/failover
 */
import type {
  GenerateOptions,
  LlmFailure,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { classifyFailure } from './failure-class.js'
import type { AccountPool, PoolAccount } from './pool.js'
import { withAttemptAccount } from './pool.js'

const MAX_ATTEMPTS = 3

/** How one attempt ended before the caller saw anything, or that it did not. */
type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'forwarded'; failure: LlmFailure }
  | { kind: 'failed'; failure: LlmFailure; error: LlmError }

/** Adapter options plus the live pools by route, read once per stream. */
export interface FailoverPiAiAdapterOptions extends PiAiAdapterOptions {
  pools: () => ReadonlyMap<string, AccountPool>
}

/**
 * A pi-ai adapter that starts each request on its pool's account and fails over before
 * the first chunk, trying at most three accounts.
 */
export class FailoverPiAiAdapter extends PiAiAdapter {
  private readonly pools: () => ReadonlyMap<string, AccountPool>

  constructor(options: FailoverPiAiAdapterOptions) {
    super(options)
    this.pools = options.pools
  }

  /**
   * The harness dispatches through `prepareCall`, so the failover entry point has to own
   * it as well; binding the model here keeps the base contract of one preparation.
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.pools().get(options.provider)
    if (pool === undefined) {
      yield* super.stream(options)
      return
    }
    const tried: string[] = []
    let last: { failure: LlmFailure; error: LlmError } | undefined
    while (tried.length < MAX_ATTEMPTS) {
      const account = pool.acquire({
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        model: options.model,
        exclude: tried,
      })
      if (account === undefined) {
        if (tried.length === 0) {
          throw new LlmError(
            `more-providers: no account serves model "${options.model}" on route "${options.provider}"`,
            'UNKNOWN_MODEL',
          )
        }
        break
      }
      tried.push(account.id)
      const outcome = yield* this.attempt(options, account)
      if (outcome.kind === 'done') {
        pool.markSuccess(account.id)
        return
      }
      if (outcome.kind === 'stopped') return
      if (outcome.kind === 'forwarded') {
        if (classifyFailure(outcome.failure) === 'account') {
          pool.markFailure(account.id, outcome.failure)
        }
        return
      }
      const tier = classifyFailure(outcome.failure)
      if (tier === 'account') pool.markFailure(account.id, outcome.failure)
      if (tier === 'terminal') throw outcome.error
      last = outcome
    }
    if (last !== undefined) throw last.error
  }

  /** One attempt under one account; buffers the leading chunks so a failure stays invisible. */
  private async *attempt(
    options: GenerateOptions,
    account: PoolAccount,
  ): AsyncGenerator<StreamChunk, AttemptOutcome> {
    const context = { route: options.provider, account }
    const iterator = super.stream(options)[Symbol.asyncIterator]()
    const pending: StreamChunk[] = []
    let started = false
    try {
      while (true) {
        const next = await withAttemptAccount(context, () => iterator.next())
        if (next.done === true) {
          if (!started) return closedFailure()
          throw new LlmError(
            'more-providers: the model stream ended before its finish chunk',
            'STREAM_CLOSED',
          )
        }
        const chunk = next.value
        if (chunk.type !== 'finish') {
          if (!started) {
            if (chunk.type === 'usage') {
              pending.push(chunk)
              continue
            }
            started = true
            yield* pending.splice(0)
          }
          yield chunk
          continue
        }
        const reason = chunk.reason
        if (reason.kind === 'error') {
          if (started) {
            yield chunk
            return { kind: 'forwarded', failure: reason.failure }
          }
          return {
            kind: 'failed',
            failure: reason.failure,
            error: LlmError.fromFailure(reason.failure),
          }
        }
        started = true
        yield* pending.splice(0)
        yield chunk
        return reason.kind === 'aborted' ? { kind: 'stopped' } : { kind: 'done' }
      }
    } catch (error) {
      if (started) throw error
      if (error instanceof LlmError) {
        if (error.code === 'ABORTED' || options.signal?.aborted === true) throw error
        return { kind: 'failed', failure: error.failure, error }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'failed',
        failure: { message, code: 'PI_AI_ERROR' },
        error: new LlmError(message, 'PI_AI_ERROR', { cause: error }),
      }
    }
  }
}

function closedFailure(): AttemptOutcome {
  const failure: LlmFailure = {
    message: 'the model stream ended without a chunk',
    code: 'STREAM_CLOSED',
  }
  return {
    kind: 'failed',
    failure,
    error: new LlmError(
      'more-providers: the model stream ended before its first chunk',
      'STREAM_CLOSED',
    ),
  }
}
