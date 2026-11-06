/**
 * Browser ↔ host channel for the new-session jj option.
 *
 * The stock Forge option is only reachable from a Git checkout. This route
 * tells the client whether the Session's project is a jj workspace without a
 * Git checkout, which is exactly the case the stock option cannot render; the
 * client then drives the stock request/creation lifecycle through the Forge
 * panel Remote, so the workspace service (and its bookmark rules) stay shared.
 *
 * @module dsh-jj-workspace/channel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JjTaskState } from './jj.js'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Status requests are tiny; anything bigger is a misbehaving client. */
const MAX_CHANNEL_BODY_BYTES = 8 * 1024

/** The channel prefix the browser posts the connection envelope to. */
export const RPC_CHANNEL = '/dsh-jj-workspace'

/** Why the jj option cannot create a workspace under the Session's current policy. */
export type JjBlocker = 'read-only' | 'outside-writable-root' | 'jj-unavailable'

/** What the browser needs to decide whether to offer the jj option. */
export interface JjStatus {
  /** The nearest VCS root: none, a Git checkout, or a jj workspace. */
  kind: 'none' | 'git' | 'jj'
  /** The nearest VCS root, when one was found. */
  root?: string
  /** Whether the jj workspace is colocated with a Git checkout. */
  hasGit?: boolean
  /** Null when a jj workspace can be created, else the blocking reason. */
  blocker?: JjBlocker | null
  /** Local bookmark names available as an explicit base. */
  bookmarks?: string[]
}

/** The host side of the channel. */
export interface JjStatusSource {
  /** Resolve the Session's effective directory and classify it. */
  status(sessionId: string): Promise<JjStatus>
  /** Read the durable tasks of the Session with their current workspace/bookmark state. */
  taskStates(sessionId: string): Promise<JjTaskState[]>
}

/**
 * Mount the status route once the connection service and a web server exist.
 * Authentication and framing mirror the connection RPC grammar, so the client
 * cannot read a Session's directory without the same admission the rest of the
 * page uses.
 */
export function registerChannel(ctx: Context, source: JjStatusSource): void {
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
    const payload = envelope.payload as { sessionId?: unknown }
    const sessionId = payload.sessionId
    let result:
      | { ok: true; value: JjStatus | { tasks: JjTaskState[] } }
      | { ok: false; error: { code: string; message: string; details: object } }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      result = {
        ok: false,
        error: { code: 'UNKNOWN_ENDPOINT', message: `Unknown endpoint or payload "${endpoint}"`, details: {} },
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
