/**
 * The browser channel: one web-server prefix route (`/dsh-triggers`) speaking
 * the connection RPC envelope (same grammar as dsh-handoff / dsh-context-audit).
 *
 * The table editor is a full-snapshot client: every mutation is a small RPC
 * (`template.save`, `run.control`, …) and `state` re-reads the domain, so the
 * UI and the model tool always drive the SAME host state — there is no second
 * write path in the browser.
 *
 * @module dsh-triggers/channel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PACKAGE_NAME, RPC_CHANNEL } from './identity.js'
import type { TriggerService } from './service.js'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Template bodies ride the channel; keep a generous but finite ceiling. */
const MAX_CHANNEL_BODY_BYTES = 256 * 1024

type ChannelResult = { ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }

/** Dispatch one endpoint against the trigger service. */
async function handle(service: TriggerService, endpoint: string, payload: Record<string, unknown>): Promise<ChannelResult> {
  try {
    switch (endpoint) {
      case 'state':
        return { ok: true, value: await service.snapshot() }
      case 'sessions':
        return { ok: true, value: { items: await service.sessions() } }
      case 'template.save':
        return { ok: true, value: await service.saveTemplate(payload as Parameters<typeof service.saveTemplate>[0]) }
      case 'template.delete': {
        if (typeof payload.id !== 'string') return bad(endpoint, 'id must be a string')
        await service.deleteTemplate(payload.id)
        return { ok: true, value: { deleted: true } }
      }
      case 'binding.save':
        return { ok: true, value: await service.saveBinding(payload as Parameters<typeof service.saveBinding>[0]) }
      case 'binding.delete': {
        if (typeof payload.id !== 'string') return bad(endpoint, 'id must be a string')
        await service.deleteBinding(payload.id)
        return { ok: true, value: { deleted: true } }
      }
      case 'run.start': {
        if (typeof payload.bindingId !== 'string') return bad(endpoint, 'bindingId must be a string')
        const task = typeof payload.task === 'string' ? payload.task : undefined
        return { ok: true, value: await service.startRunFromBinding(payload.bindingId, task) }
      }
      case 'run.control': {
        const action = payload.action
        if (typeof payload.runId !== 'string' || typeof action !== 'string' ||
          !['pause', 'resume', 'cancel', 'extend', 'redeliver'].includes(action)) {
          return bad(endpoint, 'runId and a known action are required')
        }
        const message = typeof payload.message === 'string' ? payload.message : undefined
        const newMaxRounds = typeof payload.newMaxRounds === 'number' ? payload.newMaxRounds : undefined
        const deliveryId = typeof payload.deliveryId === 'string' ? payload.deliveryId : undefined
        const run = await service.controlRun(
          payload.runId,
          action as 'pause' | 'resume' | 'cancel' | 'extend' | 'redeliver',
          { message, newMaxRounds, deliveryId },
        )
        return { ok: true, value: run }
      }
      default:
        return { ok: false, error: { code: 'UNKNOWN_ENDPOINT', message: `Unknown endpoint "${endpoint}"` } }
    }
  } catch (error) {
    return { ok: false, error: { code: 'TRIGGER_ERROR', message: error instanceof Error ? error.message : String(error) } }
  }
}

function bad(_endpoint: string, message: string): ChannelResult {
  return { ok: false, error: { code: 'BAD_PAYLOAD', message } }
}

/**
 * Mount the channel route; appears once the connection service and a web
 * server are both present (soft-injected), mirroring the other packages.
 */
export function registerTriggerChannel(ctx: Context, service: TriggerService): void {
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
    let envelope: { type?: unknown, rpcId?: unknown, method?: unknown, payload?: unknown }
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
    const result = await handle(service, endpoint, envelope.payload as Record<string, unknown>)
    respond(200, JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }))
  }

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(() => svcCtx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => serve(svcCtx, req, res),
    }), `${RPC_CHANNEL} trigger channel`)
    svcCtx.logger(PACKAGE_NAME).info('trigger channel mounted', { path: RPC_CHANNEL })
  })
}
