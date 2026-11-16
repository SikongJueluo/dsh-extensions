/**
 * Browser ↔ host channel: one web-server prefix route (the connection RPC
 * envelope grammar) serving the Settings section's quota reads.
 *
 * Endpoints:
 * - `quota` — every monitored provider with its latest snapshot; a truthy
 *   `refresh` bypasses the cache. Never throws: each provider reports its own
 *   fetch outcome.
 *
 * @module dsh-plan-usage/channel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RPC_CHANNEL } from './identity.js'
import type { PlanUsageService } from './service.js'
import { isRecord } from './sources/contracts.js'
import type { QuotaSnapshot } from './types.js'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/u
/** Quota requests are tiny; anything bigger is a misbehaving client. */
const MAX_CHANNEL_BODY_BYTES = 16 * 1024

/** What the browser sees for one monitored provider. */
interface ProviderQuotaView {
  provider: string
  snapshot?: QuotaSnapshot
  /** Why the quota is unavailable, when known. */
  error?: string
}

/** Serve one `quota` request; routes without a resolvable key are omitted. */
async function quotaView(
  service: PlanUsageService,
  refresh: boolean,
): Promise<{ providers: ProviderQuotaView[] }> {
  const monitored = service.providers().filter((provider) => service.monitored(provider))
  const views = await Promise.all(
    monitored.map(async (provider): Promise<ProviderQuotaView> => {
      const snapshot = await service.get(provider, { force: refresh })
      if (snapshot !== undefined) return { provider, snapshot }
      const sourceId = service.sourceId(provider)
      return {
        provider,
        error:
          sourceId === 'openai-codex'
            ? 'no signed-in ChatGPT token, or the usage fetch failed (see host logs)'
            : 'quota fetch failed (see host logs)',
      }
    }),
  )
  return { providers: views }
}

/**
 * Mount the channel route; appears once the connection service and a web
 * server are both present (soft-injected), mirroring dsh-oauth-providers.
 */
export function registerChannel(ctx: Context, service: PlanUsageService): void {
  const handler = async (
    endpoint: string,
    payload: unknown,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string; details: object } }
  > => {
    if (endpoint === 'quota') {
      const refresh = isRecord(payload) && payload.refresh === true
      return { ok: true, value: await quotaView(service, refresh) }
    }
    return {
      ok: false,
      error: { code: 'UNKNOWN_ENDPOINT', message: `Unknown endpoint "${endpoint}"`, details: {} },
    }
  }

  const serve = async (
    svcCtx: Context,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
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
    if (
      (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json'
    ) {
      respond(415, '{}')
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const raw of req) {
      // The request stream emits Buffers only (`setEncoding` is never called
      // on it); the guard makes that assumption explicit instead of asserting
      // it per chunk.
      if (!Buffer.isBuffer(raw)) {
        respond(413, '{}')
        req.destroy()
        return
      }
      received += raw.byteLength
      if (received > MAX_CHANNEL_BODY_BYTES) {
        respond(413, '{}')
        req.destroy()
        return
      }
      chunks.push(raw)
    }
    let envelope:
      | { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
      | undefined
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      envelope = isRecord(parsed) ? parsed : undefined
    } catch {
      respond(400, '{}')
      return
    }
    if (
      envelope === undefined ||
      envelope.type !== 'client-request' ||
      typeof envelope.rpcId !== 'string' ||
      envelope.rpcId.length === 0 ||
      envelope.method !== endpoint ||
      typeof envelope.payload !== 'object' ||
      envelope.payload === null
    ) {
      respond(400, '{}')
      return
    }
    const result = await handler(endpoint, envelope.payload)
    respond(200, JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }))
  }

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(
      () =>
        svcCtx.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: (req, res) => serve(svcCtx, req, res),
        }),
      `${RPC_CHANNEL} quota channel`,
    )
  })
}
