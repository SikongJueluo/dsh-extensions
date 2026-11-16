/**
 * Minimal JSON-over-HTTP plumbing for the provider adapters.
 *
 * Injectable on purpose: the adapters accept a `postJson` function so unit
 * tests script responses and failures without a network.
 *
 * @module dsh-search-integrator/http
 */

import { isRecord } from './types.js'

/** A non-2xx HTTP response, carrying the status for retry classification. */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = 'HttpError'
    this.status = status
  }
}

/** POST JSON and parse a JSON response; rejects on non-2xx or transport errors. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  }).catch(attachCause)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HttpError(response.status, text)
  }
  return response.json()
}

/** GET and parse a JSON response; rejects on non-2xx or transport errors. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal }).catch(attachCause)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HttpError(response.status, text)
  }
  return response.json()
}

/** Un-hide the OS-level cause of a fetch failure (ETIMEDOUT, ECONNRESET, …). */
function attachCause(error: unknown): never {
  if (error instanceof TypeError && isRecord(error.cause)) {
    const note: unknown = error.cause.code ?? error.cause.message ?? 'unknown'
    const wrapped = new TypeError(`${error.message} (${String(note)})`)
    wrapped.cause = error.cause
    throw wrapped
  }
  throw error
}

/** Sleep that rejects promptly when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('aborted'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** True for statuses worth one polite retry (rate limit / transient server). */
function retryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599)
}

/**
 * Run `fn` with a bounded retry: one extra attempt on a retryable HTTP status
 * or a network-level failure, with signal-aware backoff. Abort propagates
 * immediately and never retries.
 *
 * @param fn - the attempt runner; receives the 1-based attempt number.
 * @param retries - extra attempts after the first (default 1).
 * @param signal - cancellation shared with the caller's budget.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: { retries?: number; signal: AbortSignal },
): Promise<T> {
  const { retries = 1, signal = new AbortController().signal } = options ?? {}
  let lastError: unknown
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (signal.aborted) throw error
      const retryable =
        error instanceof HttpError ? retryableStatus(error.status) : error instanceof TypeError // fetch() network failure
      if (!retryable || attempt > retries) throw error
      lastError = error
      await sleep(400 * attempt + Math.floor(Math.random() * 200), signal)
    }
  }
  throw lastError
}
