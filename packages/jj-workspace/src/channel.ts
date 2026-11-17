/** @module dsh-jj-workspace/channel */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JjTaskState } from './jj.js'

const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/u
const MAX_CHANNEL_BODY_BYTES = 8 * 1024

const RPC_CHANNEL = '/dsh-jj-workspace'

/** Whether a decoded JSON value is an object read field by field. The stock connection grammar treats any non-null object (arrays included) as a candidate envelope/payload, so the guard deliberately keeps arrays. */
function isEnvelopeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The bytes of one request chunk; `IncomingMessage` yields Buffers while no encoding is set. */
function toBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
}

/** Why the jj option cannot create a workspace under the Session's current policy. */
export type JjBlocker = 'read-only' | 'outside-writable-root' | 'jj-unavailable'

/** What the browser needs to decide whether to offer the jj option. */
export interface JjStatus {
  kind: 'none' | 'git' | 'jj'
  root?: string
  hasGit?: boolean
  blocker?: JjBlocker | null
  bookmarks?: string[]
}

/** The host side of the channel. */
export interface JjStatusSource {
  /** Resolve the Session's effective directory and classify it. */
  status(sessionId: string): Promise<JjStatus>
  /** Read the durable tasks of the Session with their current workspace/bookmark state. */
  taskStates(sessionId: string): Promise<JjTaskState[]>
}

/** Mount the status route once the connection service and a web server exist. Authentication and framing mirror the connection RPC grammar, so the client cannot read a Session's directory without the same admission the rest of the page uses. */
export function registerChannel(ctx: Context, source: JjStatusSource): void {
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
    for await (const chunk of req) {
      const data = toBuffer(chunk)
      received += data.byteLength
      if (received > MAX_CHANNEL_BODY_BYTES) {
        respond(413, '{}')
        req.destroy()
        return
      }
      chunks.push(data)
    }
    let envelope: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (isEnvelopeObject(parsed)) envelope = parsed
    } catch {
      respond(400, '{}')
      return
    }
    if (envelope === undefined) {
      respond(400, '{}')
      return
    }
    if (
      envelope.type !== 'client-request' ||
      typeof envelope.rpcId !== 'string' ||
      envelope.rpcId.length === 0 ||
      envelope.method !== endpoint ||
      !isEnvelopeObject(envelope.payload)
    ) {
      respond(400, '{}')
      return
    }
    const sessionId = envelope.payload.sessionId
    let result:
      | { ok: true; value: JjStatus | { tasks: JjTaskState[] } }
      | { ok: false; error: { code: string; message: string; details: object } }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      result = {
        ok: false,
        error: {
          code: 'UNKNOWN_ENDPOINT',
          message: `Unknown endpoint or payload "${endpoint}"`,
          details: {},
        },
      }
    } else if (endpoint === 'status') {
      result = { ok: true, value: await source.status(sessionId) }
    } else if (endpoint === 'tasks') {
      result = { ok: true, value: { tasks: await source.taskStates(sessionId) } }
    } else {
      result = {
        ok: false,
        error: { code: 'UNKNOWN_ENDPOINT', message: `Unknown endpoint "${endpoint}"`, details: {} },
      }
    }
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
      `${RPC_CHANNEL} status channel`,
    )
  })
}
