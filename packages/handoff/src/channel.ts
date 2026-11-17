/**
 * The package's browser channel: one web-server prefix route speaking the connection RPC envelope, over which the Web half polls for a pending model pick and submits the answer.
 * @module dsh-handoff/channel
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PACKAGE_NAME, RPC_CHANNEL } from './identity.js'
import {
  coerceModelChoice,
  coercePresetChoice,
  isRecord,
  type ModelChoice,
  type PresetChoice,
} from './choice.js'

const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/u
const MAX_BODY_BYTES = 64 * 1024
const ATTACHED_WINDOW_MS = 8_000

/** One route the browser may show as a base option, with the effort in force. */
export interface RouteWire {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One preset row the browser may offer. */
export interface PresetWire {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

/** The preset block of a pending pick; absent when the composition has no registry. */
export interface PresetRequestWire {
  readonly inherited?: string
  readonly options: readonly PresetWire[]
  readonly default: PresetChoice
  readonly defaultIssue?: string
}

/** One workspace row the browser may list (registry snapshot, command time). */
export interface WorkspaceWire {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly missing: boolean
}

/** What the browser learns about one pending pick. */
export interface ChoiceRequestWire {
  readonly id: string
  readonly sessionId: string
  readonly task: string
  readonly inherited?: RouteWire
  readonly fallback?: RouteWire
  readonly defaultChoice?: ModelChoice
  readonly defaultChoiceIssue?: string
  readonly preset?: PresetRequestWire
  readonly origin?: WorkspaceWire
  readonly workspaces?: readonly WorkspaceWire[]
  readonly pickWorkspace?: boolean
  readonly modelFixed?: boolean
  readonly fixedModel?: RouteWire
  readonly fixedWorkspace?: WorkspaceWire
  readonly previous?: {
    readonly workspaceId?: WorkspacePick
  }
  readonly review?: {
    readonly defaultRounds: number
    readonly enabled?: boolean
    readonly fixed?: boolean
  }
}

/** The workspace verdict riding a choice: `'origin'` (the literal the callers compare against) or a registry id. */
export type WorkspacePick = string

/** The auto-review verdict riding a choice. */
export interface ReviewPick {
  readonly enabled: boolean
  readonly rounds: number
}

/** The user's verdict on one pending pick. */
export type ChoiceOutcome =
  | {
      kind: 'choice'
      choice: ModelChoice
      workspace: WorkspacePick
      preset?: PresetChoice
      review?: ReviewPick
    }
  | { kind: 'cancel' }

interface PendingChoice extends ChoiceRequestWire {
  settle: (outcome: ChoiceOutcome) => void
}
/** The package's browser-facing pick channel. */
export interface HandoffChannel {
  /**
   * Publish one pending pick and await the browser's answer.
   * @returns the outcome, or `undefined` when nobody answered in time.
   */
  request(
    input: Omit<ChoiceRequestWire, 'id'>,
    timeoutMs: number,
  ): Promise<ChoiceOutcome | undefined>
  /** Whether a browser has polled recently enough to be worth waiting for. */
  clientAttached(): boolean
}

/** Narrow the model part of an untrusted browser payload. */
function parseModelChoice(record: Record<string, unknown>): ModelChoice | undefined {
  return coerceModelChoice(record)
}

/** Narrow the preset verdict of an untrusted browser payload. The caller has already treated an absent field as "no opinion"; an explicit id here must be one the host actually offered. */
function parsePresetChoice(
  value: unknown,
  block: PresetRequestWire | undefined,
): PresetChoice | undefined {
  const parsed = coercePresetChoice(value)
  if (parsed === undefined) return undefined
  if (
    parsed.kind === 'preset' &&
    (block === undefined || !block.options.some((option) => option.id === parsed.id))
  ) {
    return undefined
  }
  return parsed
}

/** Narrow the review verdict of an untrusted browser payload: absent means "not offered / left off". */
function parseReview(value: unknown, defaultRounds: number): ReviewPick | undefined {
  if (!isRecord(value)) return undefined
  const record = value
  if (typeof record.enabled !== 'boolean') return undefined
  const rounds = record.rounds === undefined ? defaultRounds : record.rounds
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > 50)
    return undefined
  return { enabled: record.enabled, rounds }
}

/** Narrow untrusted browser payloads into a choice plus its workspace and preset verdicts. An absent workspace field means `'origin'` (single-workspace deployments and flag-resolved targets never run the browser step). */
function parseChoice(
  value: unknown,
  defaultReviewRounds: number | undefined,
  presetBlock: PresetRequestWire | undefined,
):
  | { choice: ModelChoice; workspace: WorkspacePick; preset?: PresetChoice; review?: ReviewPick }
  | undefined {
  if (!isRecord(value)) return undefined
  const record = value
  const choice = parseModelChoice(record)
  if (choice === undefined) return undefined
  let preset: PresetChoice | undefined
  if (record.preset !== undefined) {
    preset = parsePresetChoice(record.preset, presetBlock)
    if (preset === undefined) return undefined
  }
  const raw = record.workspace
  if (raw !== undefined && (typeof raw !== 'string' || raw.length === 0)) return undefined
  const review =
    record.review === undefined || defaultReviewRounds === undefined
      ? undefined
      : parseReview(record.review, defaultReviewRounds)
  if (record.review !== undefined && defaultReviewRounds !== undefined && review === undefined)
    return undefined
  return {
    choice,
    workspace: raw ?? 'origin',
    ...(preset === undefined ? {} : { preset }),
    ...(review === undefined ? {} : { review }),
  }
}

/** Register the channel route (when a connection service and a web server are composed) and return the host-side handle the command uses. */
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
        const requests: ChoiceRequestWire[] = []
        for (const entry of pending.values()) {
          requests.push({
            id: entry.id,
            sessionId: entry.sessionId,
            task: entry.task,
            ...(entry.inherited === undefined ? {} : { inherited: entry.inherited }),
            ...(entry.fallback === undefined ? {} : { fallback: entry.fallback }),
            ...(entry.defaultChoice === undefined ? {} : { defaultChoice: entry.defaultChoice }),
            ...(entry.defaultChoiceIssue === undefined
              ? {}
              : { defaultChoiceIssue: entry.defaultChoiceIssue }),
            ...(entry.preset === undefined ? {} : { preset: entry.preset }),
            ...(entry.origin === undefined ? {} : { origin: entry.origin }),
            ...(entry.workspaces === undefined ? {} : { workspaces: entry.workspaces }),
            ...(entry.pickWorkspace === undefined ? {} : { pickWorkspace: entry.pickWorkspace }),
            ...(entry.modelFixed === undefined ? {} : { modelFixed: entry.modelFixed }),
            ...(entry.fixedModel === undefined ? {} : { fixedModel: entry.fixedModel }),
            ...(entry.fixedWorkspace === undefined ? {} : { fixedWorkspace: entry.fixedWorkspace }),
            ...(entry.previous === undefined ? {} : { previous: entry.previous }),
            ...(entry.review === undefined ? {} : { review: entry.review }),
          })
        }
        return { requests }
      }
      case 'choose': {
        const id = payload.requestId
        if (typeof id !== 'string') return { ok: false, message: 'missing requestId' }
        const entry = pending.get(id)
        const parsed = parseChoice(payload.choice, entry?.review?.defaultRounds, entry?.preset)
        if (parsed === undefined) return { ok: false, message: 'invalid choice' }
        const settled = settlePending(id, {
          kind: 'choice',
          choice: parsed.choice,
          workspace: parsed.workspace,
          ...(parsed.preset === undefined ? {} : { preset: parsed.preset }),
          ...(parsed.review === undefined ? {} : { review: parsed.review }),
        })
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

  /** Serve one channel request: the same client-request / server-response envelope the connection RPC carriers use, on this package's own web-server prefix route. */
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
      if (!Buffer.isBuffer(chunk)) {
        respond(400, '{}')
        req.destroy()
        return
      }
      received += chunk.byteLength
      if (received > MAX_BODY_BYTES) {
        respond(413, '{}')
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      respond(400, '{}')
      return
    }
    if (
      !isRecord(parsed) ||
      parsed.type !== 'client-request' ||
      typeof parsed.rpcId !== 'string' ||
      parsed.rpcId.length === 0 ||
      parsed.method !== endpoint ||
      !isRecord(parsed.payload)
    ) {
      respond(400, '{}')
      return
    }
    const result = await handler(svcCtx, endpoint, parsed.payload)
    respond(200, JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result }))
  }

  ctx.inject(['connection', 'webServer'], (svcCtx) => {
    svcCtx.effect(
      () =>
        svcCtx.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: (req, res) => serve(svcCtx, req, res),
        }),
      `${RPC_CHANNEL} handoff channel`,
    )
  })

  return {
    clientAttached(): boolean {
      return Date.now() - lastPollAt < ATTACHED_WINDOW_MS
    },
    request(input, timeoutMs): Promise<ChoiceOutcome | undefined> {
      const id = crypto.randomUUID()
      return new Promise<ChoiceOutcome | undefined>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          ctx
            .logger(PACKAGE_NAME)
            .warn('model pick timed out; no browser answer', { requestId: id })
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
