/**
 * Browser ↔ host channel for the write-scope panel and the plugin Fork entry.
 *
 * A same-origin relative route speaking a small JSON envelope. Admission uses
 * the connection service's Host/Origin fence and authenticated live-peer
 * check — the same boundary the rest of the page uses.
 *
 * This is the same owner-cookie / live-peer boundary the rest of the Web app
 * uses; the plugin adds no second identity gate. The management route is absent
 * from the model tool surface, and only the browser panel calls its mutations.
 *
 * @module dsh-session-write-access/channel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionWriteAccessPolicy } from './service.js'
import { AccessError } from './access.js'
import { InvalidWriteRootError, ProtectedWriteRootError } from './paths.js'

/** Route prefix owned by this plugin. */
export const RPC_CHANNEL = '/dsh-session-write-access'
/** One endpoint segment (same grammar as the connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/u
/** Panel payloads are tiny; anything bigger is a misbehaving client. */
const MAX_BODY_BYTES = 16 * 1024

/** Whether a parsed-JSON value is a plain object record (never an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

/**
 * Mount the route once connection and a web server exist. The route is an
 * effect of the plugin fiber, so unloading the bundle removes it.
 * @param ctx - plugin context.
 * @param policy - the policy service whose store the panel manages.
 */
export function registerWriteAccessChannel(ctx: Context, policy: SessionWriteAccessPolicy): void {
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
    const respond = (body: RpcResult): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end('method not allowed')
      return
    }
    if (
      (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json'
    ) {
      res.writeHead(415)
      res.end('unsupported media type')
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    // IncomingMessage is `AsyncIterable<any>` in the node typings; the request
    // stream yields Buffers unless an encoding was set (never here), so the
    // annotation records that fact instead of casting every chunk.
    const body: AsyncIterable<Buffer> = req
    for await (const chunk of body) {
      received += chunk.byteLength
      if (received > MAX_BODY_BYTES) {
        res.writeHead(413)
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!isRecord(parsed)) throw new Error('not an object')
      payload = parsed
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    const method = payload.method
    if (typeof method !== 'string' || !ENDPOINT_PATTERN.test(method)) {
      respond({ ok: false, error: { code: 'UNKNOWN_METHOD', message: 'Unknown method' } })
      return
    }
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      respond({ ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
      return
    }
    try {
      await policy.ensureSession(sessionId)
      respond({ ok: true, value: await dispatch(policy, method, sessionId, payload) })
    } catch (error) {
      respond({ ok: false, error: describeError(error) })
    }
  }

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(
      () =>
        svcCtx.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: (req, res) => serve(svcCtx, req, res),
        }),
      `${RPC_CHANNEL} write-scope channel`,
    )
  })
}

/**
 * Route one admitted payload. Every branch re-reads the durable store; none
 * trusts a path, revision, or identity the browser invented beyond the
 * session it is managing.
 */
async function dispatch(
  policy: SessionWriteAccessPolicy,
  method: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'state':
      return policy.view(sessionId)
    case 'add':
      return policy.addDirectory(sessionId, requireString(payload.path, 'path'))
    case 'remove':
      return policy.removeDirectory(sessionId, requireString(payload.path, 'path'))
    case 'decide': {
      const decision = payload.decision
      if (decision !== 'allow' && decision !== 'deny')
        throw new Error('decision must be "allow" or "deny"')
      return policy.decideRequest(
        sessionId,
        requireString(payload.requestId, 'requestId'),
        decision,
        requireNonNegativeInteger(payload.expectedRevision, 'expectedRevision'),
      )
    }
    case 'fork': {
      const atSeq =
        payload.atSeq === undefined ? undefined : requireNonNegativeInteger(payload.atSeq, 'atSeq')
      return policy.forkSession(sessionId, atSeq)
    }
    default:
      throw new Error(`Unknown method ${JSON.stringify(method)}`)
  }
}

/** Map a refusal to the stable code/message the panel displays. */
function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof AccessError) return { code: error.code, message: error.message }
  if (error instanceof InvalidWriteRootError || error instanceof ProtectedWriteRootError) {
    return { code: 'INVALID_PATH', message: error.message }
  }
  return { code: 'FAILED', message: error instanceof Error ? error.message : String(error) }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}
