/**
 * Browser ↔ host channel: one web-server prefix route (the connection RPC
 * envelope grammar, same as dsh-plan-usage) serving the sidebar panel's
 * report reads.
 *
 * Endpoints:
 * - `report` — the full audit report for a window; `days` is a positive
 *   number or absent for all history. The scan is synchronous-over-local
 *   files (a few seconds over a typical store) and serialized behind the
 *   previous one so double-clicks cannot stampede.
 *
 * @module dsh-context-audit/channel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { collectAudit } from './audit.js'

/** Route prefix this channel serves on the host web server. */
export const RPC_CHANNEL = '/dsh-context-audit'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Report requests are tiny; anything bigger is a misbehaving client. */
const MAX_CHANNEL_BODY_BYTES = 16 * 1024

/** `$DSH_HOME` (matching dsh-home-paths) over `~/.dsh`. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export interface ChannelDeps {
  /** Config defaults shared with the command (window / table sizes). */
  defaultDays: number
  sessionLimit: number
}

/**
 * Mount the channel route; appears once the connection service and a web
 * server are both present (soft-injected), mirroring dsh-plan-usage.
 */
export function registerChannel(ctx: Context, deps: ChannelDeps): void {
  let inFlight: Promise<unknown> = Promise.resolve()

  const handler = async (
    endpoint: string,
    payload: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }> => {
    if (endpoint !== 'report') {
      return { ok: false, error: { code: 'UNKNOWN_ENDPOINT', message: `Unknown endpoint "${endpoint}"`, details: {} } }
    }
    const rawDays = (payload as { days?: unknown } | null | undefined)?.days
    let days: number | undefined
    if (rawDays === undefined || rawDays === null || rawDays === 'all') {
      days = undefined
    } else if (typeof rawDays === 'number' && Number.isFinite(rawDays) && rawDays >= 1) {
      days = Math.min(3650, Math.floor(rawDays))
    } else {
      return { ok: false, error: { code: 'BAD_DAYS', message: 'days must be a positive number or "all"', details: {} } }
    }
    const home = dshHome()
    const run = async (): Promise<unknown> => collectAudit(
      join(home, 'sessions'),
      join(home, 'storages', 'session_projcache', 'sessions'),
      { days, sessionLimit: deps.sessionLimit, now: Date.now() },
    )
    // Serialize scans: overlapping requests reuse the queued run's result.
    const queued = inFlight.then(run, run)
    inFlight = queued.catch(() => undefined)
    return { ok: true, value: await queued }
  }

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
      if (received > MAX_CHANNEL_BODY_BYTES) {
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
    const result = await handler(endpoint, envelope.payload)
    respond(200, JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }))
  }

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(() => svcCtx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => serve(svcCtx, req, res),
    }), `${RPC_CHANNEL} report channel`)
  })
}
