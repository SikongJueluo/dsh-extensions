/**
 * The `/dsh-more-providers/refresh` action route: `POST` re-runs catalog discovery for every mounted instance, so a `modelsURL` fetch that failed during a reload can be retried without restarting dsh.
 * @module dsh-more-providers/refresh
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 64 * 1024

/** One instance's catalog re-run; a rejection is reported per instance instead of failing the whole request. */
export type CatalogRescan = () => Promise<void>

/** One instance's refresh outcome, as the browser reads it. */
interface InstanceReport {
  id: string
  ok: boolean
  error?: string
}

interface RefreshClient {
  id: number
  title: string
  rescan: CatalogRescan
  webServer?: Context['webServer']
  connection?: Pick<Context['connection'], 'requestRejection'>
}

interface RefreshHub {
  clients: Map<number, RefreshClient>
  route?: { ownerId: number; dispose: () => void }
  nextId: number
}

const hubs = new Map<string, RefreshHub>()

function hubFor(path: string): RefreshHub {
  const existing = hubs.get(path)
  if (existing !== undefined) return existing
  const hub: RefreshHub = { clients: new Map(), nextId: 0 }
  hubs.set(path, hub)
  return hub
}

/** Re-run every instance behind one prefix; a failed discovery stays with its own instance. */
async function serve(
  hub: RefreshHub,
  connection: NonNullable<RefreshClient['connection']>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const respond = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' })
    res.end('method not allowed')
    return
  }
  let received = 0
  for await (const chunk of req) {
    received += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk))
    if (received > MAX_BODY_BYTES) {
      respond(413, { error: 'request body is too large' })
      req.destroy()
      return
    }
  }
  const instances: InstanceReport[] = await Promise.all(
    [...hub.clients.values()].map(async (client) => {
      try {
        await client.rescan()
        return { id: `${client.title}#${String(client.id)}`, ok: true }
      } catch (error) {
        return {
          id: `${client.title}#${String(client.id)}`,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
  respond(200, { instances })
}

function ensureRefreshRoute(hub: RefreshHub, path: string): void {
  if (hub.route !== undefined || hub.clients.size === 0) return
  const owner = [...hub.clients.values()].find(
    (client) => client.webServer !== undefined && client.connection !== undefined,
  )
  if (owner?.webServer === undefined || owner.connection === undefined) return
  const connection = owner.connection
  const dispose = owner.webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => serve(hub, connection, req, res),
  })
  hub.route = { ownerId: owner.id, dispose }
}

/** Where one mounted instance exposes its catalog re-run. */
export interface ProvidersRefreshOptions {
  prefix: string
  title: string
  rescan: CatalogRescan
}

/** Serve `POST <prefix>/refresh` for every mounted instance that shares the absolute prefix, for example `/dsh-more-providers`. */
export function registerProvidersRefreshRoute(
  ctx: Context,
  options: ProvidersRefreshOptions,
): void {
  const prefix = options.prefix.replace(/\/+$/u, '')
  if (!prefix.startsWith('/') || prefix === '/') {
    throw new Error(
      `more-providers: refresh prefix must be an absolute path, got "${options.prefix}"`,
    )
  }
  const path = `${prefix}/refresh`
  const hub = hubFor(path)
  const id = ++hub.nextId
  hub.clients.set(id, { id, title: options.title, rescan: options.rescan })

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    const client = hub.clients.get(id)
    if (client === undefined) return
    client.webServer = svcCtx.webServer
    client.connection = svcCtx.connection
    ensureRefreshRoute(hub, path)
  })
  ctx.effect(
    () => () => {
      hub.clients.delete(id)
      if (hub.route?.ownerId === id) {
        hub.route.dispose()
        hub.route = undefined
        ensureRefreshRoute(hub, path)
      }
      if (hub.clients.size === 0) hubs.delete(path)
    },
    `${path} refresh`,
  )
}
