/**
 * The shared browser sign-in channel.
 *
 * One web-server prefix route (speaking the connection RPC envelope) serves
 * every provider module in this package: the browser lists providers, starts
 * an attempt, polls its notice/prompt, submits a pasted answer, declines, or
 * signs out — all addressed by provider id. The per-provider OAuth protocol
 * lives in each provider's authorization flow; this channel only relays the
 * conversation.
 *
 * The route appears when the authorization seam, the connection service, and
 * a web server are all present (soft-injected); providers register into the
 * registry at plugin load regardless, so `providers`/`status` answer even in
 * compositions without the seam.
 *
 * @module dsh-oauth-providers/channel
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: pull the `Context.connection` / `Context.webServer`
// module augmentations in.
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  AuthorizationInteraction,
  AuthorizationNotice,
  AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { RPC_CHANNEL } from './identity.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Sign-in requests are tiny; anything bigger is a misbehaving client. */
const MAX_CHANNEL_BODY_BYTES = 64 * 1024

/** One question pending on a provider's bridge, as the browser sees it. */
export interface WirePrompt {
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string }>
}

/** Everything the browser may poll about one provider's attempt. */
export interface BridgeState {
  notice?: AuthorizationNotice
  pending?: {
    prompt: WirePrompt
    resolve: (value: string) => void
    reject: (error: Error) => void
  }
  done?: { status: 'authorized' | 'cancelled' | 'failed'; message?: string }
}

/** What a provider module registers into the channel. */
export interface ProviderRegistration {
  /** Provider id (its LLM route and channel address). */
  id: string
  /** User-facing name for cards and pickers. */
  label: string
  /** The settings namespace holding this provider's editable configuration. */
  settingsNs: string
  /** The credential record its sign-in flow writes. */
  key: CredentialKey
}

interface ProviderEntry extends ProviderRegistration {
  bridge?: BridgeState
}

/** The channel registry providers register into. */
export interface AuthChannel {
  /** Declare one provider; idempotent per id. */
  register(registration: ProviderRegistration): void
}

/** Strip a prompt down to its wire-safe fields. */
function wirePrompt(prompt: AuthorizationPrompt): WirePrompt {
  const base: WirePrompt = { kind: prompt.kind, message: prompt.message }
  if (prompt.kind === 'select') {
    return { ...base, options: prompt.options.map((option) => ({ id: option.id, label: option.label })) }
  }
  return { ...base, ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}) }
}

/** Extract a string field from an unknown JSON payload. */
function field(payload: unknown, name: string): string | undefined {
  const value = (payload as Record<string, unknown> | null | undefined)?.[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Create the shared sign-in channel: a provider registry plus, once the
 * authorization seam / connection / web server are present, its HTTP route.
 */
export function registerAuthChannel(ctx: Context): AuthChannel {
  const providers = new Map<string, ProviderEntry>()

  const interactionOf = (entry: ProviderEntry): AuthorizationInteraction => ({
    notify: (notice) => {
      if (entry.bridge !== undefined) entry.bridge.notice = notice
    },
    prompt: (prompt) =>
      new Promise<string>((resolve, reject) => {
        if (entry.bridge === undefined) {
          reject(new Error('No surface is watching this sign-in'))
          return
        }
        const pending = { prompt: wirePrompt(prompt), resolve, reject }
        entry.bridge.pending = pending
        // The flow withdrawing its own (losing) question is not a decline.
        prompt.signal?.addEventListener('abort', () => {
          if (entry.bridge?.pending === pending) entry.bridge.pending = undefined
          reject(new Error('Authorization prompt withdrawn'))
        }, { once: true })
      }),
  })

  const settle = (entry: ProviderEntry, status: 'authorized' | 'cancelled' | 'failed', message?: string): void => {
    if (entry.bridge === undefined) return
    entry.bridge.pending = undefined
    entry.bridge.done = { status, ...(message !== undefined ? { message } : {}) }
  }

  const begin = async (svcCtx: Context, entry: ProviderEntry): Promise<Record<string, unknown>> => {
    if (entry.bridge !== undefined && entry.bridge.done === undefined) return { started: false, running: true }
    entry.bridge = {}
    void svcCtx.authorization
      .begin({ key: entry.key, interaction: interactionOf(entry) })
      .then((outcome) => settle(entry, outcome.status))
      .catch((error: Error) => settle(entry, 'failed', error.message))
    return { started: true, running: true }
  }

  const handler = async (
    svcCtx: Context,
    endpoint: string,
    payload: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }> => {
    const failure = (code: string, message: string): { ok: false; error: { code: string; message: string; details: object } } => ({
      ok: false,
      error: { code, message, details: {} },
    })
    const entryOf = (id: string | undefined): ProviderEntry | undefined =>
      id !== undefined ? providers.get(id) : undefined
    try {
      switch (endpoint) {
        case 'providers': {
          const list: Array<Record<string, unknown>> = []
          for (const entry of providers.values()) {
            const info = await svcCtx.credentials.describeRecord(entry.key)
            list.push({
              id: entry.id,
              label: entry.label,
              settingsNs: entry.settingsNs,
              signedIn: info?.configured === true,
              running: entry.bridge !== undefined && entry.bridge.done === undefined,
            })
          }
          return { ok: true, value: { providers: list } }
        }
        default: {
          const entry = entryOf(field(payload, 'provider'))
          if (entry === undefined) return failure('UNKNOWN_PROVIDER', `No provider "${field(payload, 'provider')}" is registered`)
          switch (endpoint) {
            case 'status': {
              const info = await svcCtx.credentials.describeRecord(entry.key)
              return { ok: true, value: { signedIn: info?.configured === true, running: entry.bridge !== undefined && entry.bridge.done === undefined } }
            }
            case 'begin':
              return { ok: true, value: await begin(svcCtx, entry) }
            case 'poll': {
              const state = entry.bridge
              if (state === undefined) return { ok: true, value: { running: false } }
              const value: Record<string, unknown> = { running: state.done === undefined }
              if (state.notice !== undefined) value.notice = state.notice
              if (state.pending !== undefined) value.prompt = state.pending.prompt
              if (state.done !== undefined) value.done = state.done
              return { ok: true, value }
            }
            case 'submit': {
              const input = field(payload, 'input')
              const state = entry.bridge
              const pending = state?.pending
              if (state === undefined || pending === undefined || input === undefined) {
                return failure('NO_PROMPT', 'No sign-in question is waiting for an answer')
              }
              pending.resolve(input)
              state.pending = undefined
              return { ok: true, value: { accepted: true } }
            }
            case 'decline': {
              const state = entry.bridge
              const pending = state?.pending
              if (state === undefined || pending === undefined) {
                return failure('NO_PROMPT', 'No sign-in question is waiting for an answer')
              }
              state.pending = undefined
              // Withdraw the whole attempt rather than rejecting the prompt
              // with a decline: an out-of-tree plugin's error classes are
              // distinct module instances from the host's, so the seam's
              // instanceof check would not recognize ours. `cancel()` aborts
              // the attempt signal, which settles it as `cancelled`, and the
              // rejected prompt unblocks the flow so it finishes its cleanup.
              pending.reject(new Error('Declined in the settings page'))
              svcCtx.authorization.cancel(entry.key)
              return { ok: true, value: { accepted: true } }
            }
            case 'cancel': {
              svcCtx.authorization.cancel(entry.key)
              return { ok: true, value: { accepted: true } }
            }
            case 'logout': {
              await svcCtx.credentials.deleteRecord(entry.key)
              return { ok: true, value: { signedIn: false } }
            }
            default:
              return failure('UNKNOWN_ENDPOINT', `Unknown sign-in endpoint "${endpoint}"`)
          }
        }
      }
    } catch (error) {
      return failure('SIGNIN_FAILED', (error as Error).message)
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
    const result = await handler(svcCtx, endpoint, envelope.payload)
    respond(200, JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }))
  }

  ctx.inject(['authorization', 'connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(() => svcCtx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => serve(svcCtx, req, res),
    }), `${RPC_CHANNEL} sign-in channel`)
  })

  return {
    register(registration) {
      if (!providers.has(registration.id)) providers.set(registration.id, { ...registration })
    },
  }
}
