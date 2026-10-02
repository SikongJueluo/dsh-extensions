/**
 * The package's browser channel: one web-server prefix route speaking the
 * connection RPC envelope, over which the Web half observes the judge's
 * verdicts (a small in-memory ring buffer polled by the always-mounted
 * notifier overlay — every allow/defer surfaces as a toast, so the user can
 * see the plugin at work).
 *
 * The judge route itself lives in the plugin row config and is edited through
 * the stock `remote.settings` channel; this package-private channel carries
 * only the verdict feed.
 *
 * @module dsh-auto-permit/channel
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: pull the `Context.connection` / `Context.webServer`
// module augmentations in.
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RPC_CHANNEL } from './identity.js'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Polls are tiny; anything bigger is a misbehaving client. */
const MAX_BODY_BYTES = 16 * 1024
/** Verdicts kept for late-attaching clients. */
const RING_SIZE = 50

/** Why the request settled the way it did. */
export type VerdictOutcome =
  | 'allowed'
  | 'allowed-by-memory'
  | 'deferred'
  | 'high-risk'

/** One recorded verdict, as the browser sees it. */
export interface VerdictEntry {
  readonly seq: number
  readonly time: number
  readonly toolName: string
  readonly command: string
  readonly outcome: VerdictOutcome
}

/** The host-side verdict feed. */
export interface VerdictFeed {
  /** Record one verdict (also keeps the ring buffer for late pollers). */
  record(entry: Omit<VerdictEntry, 'seq' | 'time'>): void
}

const ring: VerdictEntry[] = []
let ringSeq = 0

function record(entry: Omit<VerdictEntry, 'seq' | 'time'>): void {
  ringSeq += 1
  ring.push({ ...entry, seq: ringSeq, time: Date.now() })
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
}

/**
 * Register the channel route (when a connection service and a web server are
 * composed): `events` returns the verdicts after a sequence cursor.
 */
export function registerChannel(ctx: Context): VerdictFeed {
  const handler = async (
    _svcCtx: Context,
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    switch (endpoint) {
      case 'events': {
        // A fresh attacher (no `since` cursor yet) skips the backlog: it
        // returns no events but the current cursor, so only verdicts recorded
        // from now on surface as toasts.
        const since = payload.since
        if (typeof since !== 'number' || !Number.isFinite(since)) {
          return { events: [], next: ringSeq }
        }
        const events = ring.filter((entry) => entry.seq > since)
        return { events, next: ringSeq }
      }
      default:
        return { ok: false, message: `unknown endpoint "${endpoint}"` }
    }
  }

  /** Serve one channel request: the client-request / server-response envelope. */
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
    }), `${RPC_CHANNEL} auto-permit channel`)
  })

  return { record }
}
