/**
 * The package's browser channel: one web-server prefix route speaking the
 * connection RPC envelope, over which the Web half polls for a pending model
 * pick and submits the answer.
 *
 * The host holds each pending pick in memory; the browser's poll is also the
 * liveness signal that decides whether waiting for a real picker is worthwhile
 * (a TUI deployment never polls, so the command falls back to the shipped
 * question card instead of blocking).
 *
 * @module dsh-handoff/channel
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: pull the `Context.connection` / `Context.webServer`
// module augmentations in.
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PACKAGE_NAME, RPC_CHANNEL } from './identity.js'
import type { ModelChoice } from './brief.js'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Picks are tiny; anything bigger is a misbehaving client. */
const MAX_BODY_BYTES = 64 * 1024
/** A browser that polled this recently counts as attached to this command surface. */
const ATTACHED_WINDOW_MS = 8_000

/** What the browser learns about one pending pick. */
export interface ChoiceRequestWire {
  readonly id: string
  readonly sessionId: string
  readonly task: string
  readonly inherited?: { provider: string; model: string }
  readonly fallback?: { provider: string; model: string }
}

/** The user's verdict on one pending pick. */
export type ChoiceOutcome = { kind: 'choice'; choice: ModelChoice } | { kind: 'cancel' }

interface PendingChoice extends ChoiceRequestWire {
  settle: (outcome: ChoiceOutcome) => void
}

/** The package's browser-facing pick channel. */
export interface HandoffChannel {
  /**
   * Publish one pending pick and await the browser's answer.
   * @returns the outcome, or `undefined` when nobody answered in time.
   */
  request(input: Omit<ChoiceRequestWire, 'id'>, timeoutMs: number): Promise<ChoiceOutcome | undefined>
  /** Whether a browser has polled recently enough to be worth waiting for. */
  clientAttached(): boolean
}

/** Narrow untrusted browser payloads into a ModelChoice. */
function parseChoice(value: unknown): ModelChoice | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'inherit') return { kind: 'inherit' }
  if (record.kind === 'default') return { kind: 'default' }
  if (record.kind === 'model') {
    const provider = record.provider
    const model = record.model
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof model !== 'string' || model.length === 0) return undefined
    return { kind: 'model', provider, model }
  }
  return undefined
}

/**
 * Register the channel route (when a connection service and a web server are
 * composed) and return the host-side handle the command uses.
 */
export function registerHandoffChannel(ctx: Context): HandoffChannel {
  const pending = new Map<string, PendingChoice>()
  let lastPollAt = 0

  const settlePending = (id: string, outcome: ChoiceOutcome): boolean => {
    const entry = pending.get(id)
    if (entry === undefined) return false
    pending.delete(id)
    entry.settle(outcome)
    return true
  }

  const handler = async (
    svcCtx: Context,
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    lastPollAt = Date.now()
    switch (endpoint) {
      case 'pending': {
        const requests: ChoiceRequestWire[] = [...pending.values()].map(entry => ({
          id: entry.id,
          sessionId: entry.sessionId,
          task: entry.task,
          ...(entry.inherited === undefined ? {} : { inherited: entry.inherited }),
          ...(entry.fallback === undefined ? {} : { fallback: entry.fallback }),
        }))
        return { requests }
      }
      case 'choose': {
        const id = payload.requestId
        if (typeof id !== 'string') return { ok: false, message: 'missing requestId' }
        const choice = parseChoice(payload.choice)
        if (choice === undefined) return { ok: false, message: 'invalid choice' }
        const settled = settlePending(id, { kind: 'choice', choice })
        return settled ? { ok: true } : { ok: false, message: 'request is no longer pending' }
      }
      case 'cancel': {
        const id = payload.requestId
        if (typeof id !== 'string') return { ok: false, message: 'missing requestId' }
        const settled = settlePending(id, { kind: 'cancel' })
        return settled ? { ok: true } : { ok: false, message: 'request is no longer pending' }
      }
      default:
        return { ok: false, message: `unknown endpoint "${endpoint}"` }
    }
  }

  /**
   * Serve one channel request: the same client-request / server-response
   * envelope the connection RPC carriers use, on this package's own
   * web-server prefix route.
   */
  const serve = async (svcCtx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rejection = svcCtx.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const respond = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const endpoint = url.pathname.slice(RPC_CHANNEL.length + 1)
    if (req.method !== 'POST' || !ENDPOINT_PATTERN.test(endpoint)) {
      respond(404, '{}')
      return
    }
    if ((req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      respond(415, '{}')
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      received += (chunk as Buffer).byteLength
      if (received > MAX_BODY_BYTES) {
        respond(413, '{}')
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof envelope
    } catch {
      respond(400, '{}')
      return
    }
    if (
      envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.rpcId.length === 0 ||
      envelope.method !== endpoint || typeof envelope.payload !== 'object' || envelope.payload === null
    ) {
      respond(400, '{}')
      return
    }
    const result = await handler(svcCtx, endpoint, envelope.payload as Record<string, unknown>)
    respond(200, JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }))
  }

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(() => svcCtx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => serve(svcCtx, req, res),
    }), `${RPC_CHANNEL} handoff channel`)
  })

  return {
    clientAttached(): boolean {
      return Date.now() - lastPollAt < ATTACHED_WINDOW_MS
    },
    request(input, timeoutMs): Promise<ChoiceOutcome | undefined> {
      const id = crypto.randomUUID()
      return new Promise<ChoiceOutcome | undefined>(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id)
          ctx.logger(PACKAGE_NAME).warn('model pick timed out; no browser answer', { requestId: id })
          resolve(undefined)
        }, timeoutMs)
        pending.set(id, {
          id,
          ...input,
          settle: (outcome) => {
            clearTimeout(timer)
            resolve(outcome)
          },
        })
      })
    },
  }
}
