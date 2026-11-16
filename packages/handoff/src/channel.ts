/**
 * The package's browser channel: one web-server prefix route speaking the
 * connection RPC envelope, over which the Web half polls for a pending model
 * pick and submits the answer.
 *
 * The host holds each pending pick in memory; the browser's poll is also the
 * liveness signal that decides whether waiting for a real picker is worthwhile
 * (a TUI deployment never polls, so the command falls back to the shipped
 * question card instead of blocking).
 *
 * @module dsh-handoff/channel
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: pull the `Context.connection` / `Context.webServer`
// module augmentations in.
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PACKAGE_NAME, RPC_CHANNEL } from './identity.js'
import {
  coerceModelChoice,
  coercePresetChoice,
  type ModelChoice,
  type PresetChoice,
} from './choice.js'

/** One endpoint segment of the channel (same grammar as connection RPC). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Picks are tiny; anything bigger is a misbehaving client. */
const MAX_BODY_BYTES = 64 * 1024
/** A browser that polled this recently counts as attached to this command surface. */
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
  /** Non-empty when the preset cannot compose a session right now. */
  readonly broken?: string
}

/** The preset block of a pending pick; absent when the composition has no registry. */
export interface PresetRequestWire {
  /** The origin session's live preset; absent when it runs none. */
  readonly inherited?: string
  readonly options: readonly PresetWire[]
  /** The preset the card preselects (a retry's pick, else inherit). */
  readonly default: PresetChoice
  /** Why that default cannot mount as-is; the card must ask for a reselect. */
  readonly defaultIssue?: string
}

/** One workspace row the browser may list (registry snapshot, command time). */
export interface WorkspaceWire {
  readonly id: string
  readonly title: string
  readonly path: string
  /** The directory disappeared; the row renders greyed and unselectable. */
  readonly missing: boolean
}

/** What the browser learns about one pending pick. */
export interface ChoiceRequestWire {
  readonly id: string
  readonly sessionId: string
  readonly task: string
  readonly inherited?: RouteWire
  readonly fallback?: RouteWire
  /**
   * The model the card preselects: the retry's previous pick, else the
   * remembered handoff preference, else inherit. The browser validates it
   * against the catalog it already loads and asks for a reselect when the
   * issue field is set.
   */
  readonly defaultChoice?: ModelChoice
  /** Why {@link defaultChoice} cannot run as-is (stale model or effort). */
  readonly defaultChoiceIssue?: string
  /**
   * Preset selection block (present = the composition registers presets).
   * Preset and model are independent intents in one card.
   */
  readonly preset?: PresetRequestWire
  /** The origin session's workspace (or bare cwd when ungrouped). */
  readonly origin?: WorkspaceWire
  /** Registered workspaces other than the origin's; absent/empty = no step. */
  readonly workspaces?: readonly WorkspaceWire[]
  /** Whether the browser must run the workspace step before answering. */
  readonly pickWorkspace?: boolean
  /** The model came from `--model`; the picker starts at the workspace step. */
  readonly modelFixed?: boolean
  /** The flag-fixed route, shown in the confirmation summary (`modelFixed` only). */
  readonly fixedModel?: RouteWire
  /** The `--workspace` flag's resolved target, shown as fixed in the summary. */
  readonly fixedWorkspace?: WorkspaceWire
  /**
   * Retry defaults from the previous attempt's sidecar meta: the picker
   * pre-fills this workspace so a retry starts one click from where it left
   * off. The model and preset defaults arrive pre-resolved above.
   */
  readonly previous?: {
    readonly workspaceId?: WorkspacePick
  }
  /**
   * The auto-review block (present = dsh-triggers is mounted, or the flags
   * already decided it): the card shows the toggle with these defaults and
   * returns the verdict with the choice. `enabled` pre-checks the box (a
   * retry's previous verdict); `fixed` marks a flag-decided verdict that the
   * card displays read-only — the summary must never contradict the flags.
   */
  readonly review?: {
    readonly defaultRounds: number
    readonly enabled?: boolean
    readonly fixed?: boolean
  }
}

/** The workspace verdict riding a choice: `'origin'` or a registry id. */
export type WorkspacePick = 'origin' | (string & {})

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

/**
 * Narrow the preset verdict of an untrusted browser payload. The caller has
 * already treated an absent field as "no opinion"; an explicit id here must
 * be one the host actually offered.
 */
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

/**
 * Narrow the review verdict of an untrusted browser payload: absent means
 * "not offered / left off".
 */
function parseReview(value: unknown, defaultRounds: number): ReviewPick | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') return undefined
  const rounds = record.rounds === undefined ? defaultRounds : record.rounds
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > 50)
    return undefined
  return { enabled: record.enabled, rounds }
}

/**
 * Narrow untrusted browser payloads into a choice plus its workspace and
 * preset verdicts. An absent workspace field means `'origin'` (single-workspace
 * deployments and flag-resolved targets never run the browser step).
 */
function parseChoice(
  value: unknown,
  defaultReviewRounds: number | undefined,
  presetBlock: PresetRequestWire | undefined,
):
  | { choice: ModelChoice; workspace: WorkspacePick; preset?: PresetChoice; review?: ReviewPick }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const choice = parseModelChoice(record)
  if (choice === undefined) return undefined
  // An absent field is NO opinion: the caller keeps the host's resolved
  // intent (a retry's sidecar preset, else inherit). Only an explicit field
  // is narrowed, and it must name one of the offered rows.
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
    workspace: raw === undefined ? 'origin' : raw,
    ...(preset === undefined ? {} : { preset }),
    ...(review === undefined ? {} : { review }),
  }
}

/**
 * Register the channel route (when a connection service and a web server are
 * composed) and return the host-side handle the command uses.
 */
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
        const requests: ChoiceRequestWire[] = [...pending.values()].map((entry) => ({
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
        }))
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

  /**
   * Serve one channel request: the same client-request / server-response
   * envelope the connection RPC carriers use, on this package's own
   * web-server prefix route.
   */
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
    const result = await handler(svcCtx, endpoint, envelope.payload as Record<string, unknown>)
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
