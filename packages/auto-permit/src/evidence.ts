/**
 * Session-log evidence for one approval request.
 *
 * Everything the judge sees is folded from the requesting session's own event
 * log (`Session.snapshotEvents()`). A bash call arrives there in one of two
 * durable shapes, and both must yield the SAME evidence:
 *
 * - a directly dispatched call: `tool/call` with the call's id and its
 *   arguments as a JSON string;
 * - a PTC sub-call (bash dispatched from inside `run_code`): the host
 *   appends `tool/ptc-dispatch-start` — with the sub-call's exact execution
 *   id (`subCallId`, the id the approval request carries) and the arguments
 *   as a normalized JSON object — BEFORE it schedules the dispatch. That
 *   start event is therefore all the evidence there is at approval time;
 *   the post-execution `tool/ptc-dispatch` row is deliberately NOT read
 *   (hosts that predate the start event simply fall back to the human).
 *
 * The fold also collects the user prompts (`user/message` with a human
 * source) and this session's prior approval decisions
 * (`approval/asked`/`approval/decided` pairs — the service's own audit
 * trail, so the "approved before" memory needs no dedicated storage). All
 * call records live in ONE id-keyed index, so direct and PTC calls share
 * history and exact-repeat memory instead of each having its own.
 */
import { isAbsolute, sep } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Parsed arguments of one bash tool call, as the model produced them. */
export interface BashCall {
  command: string
  description?: string
  /** Model-supplied working directory; the host resolves it (see Evidence). */
  workdir?: string
  sandboxPermissions?: string
  justification?: string
}

/** The evidence bundle handed to the judge prompt builder. */
export interface Evidence {
  /** The pending call's parsed arguments; undefined when not recoverable. */
  call: BashCall | undefined
  /**
   * The immutable session header cwd: the original project the session was
   * created in. It is NOT the directory the next call runs in once the agent
   * changed the working directory.
   */
  workspace?: string
  /**
   * The effective working directory recorded for this session (the host's
   * `working-directory/change` projection, passed in by the listener when the
   * service is mounted; otherwise folded from the log; otherwise the header).
   */
  effectiveCwd?: string
  /**
   * The directory the pending call runs in, resolved exactly like the host:
   * an omitted workdir uses the effective cwd, a relative workdir is joined
   * to it, an absolute workdir is used as-is. Undefined when the boundary
   * cannot be established reliably.
   */
  resolvedWorkdir?: string
  /** Human-authored prompts, oldest first, bounded. */
  prompts: readonly string[]
  /** Commands this session already had allowed (bash), newest last, bounded. */
  approved: readonly string[]
  /**
   * Exact-repeat memory (log-derived): same command + escalation mode was
   * already allowed in this session. The audit trail does NOT record WHO
   * allowed it, so this is only a candidate — the listener decides whether
   * an approval's source makes it replayable (see index.ts).
   */
  exactRepeat: boolean
  /** Call ids of the prior allowed-once approvals the exact-repeat matched. */
  exactRepeatSources: readonly string[]
}

/** Upper bounds mirroring the pi ai-bash-judge calibration (evidence windows). */
export const MAX_PROMPTS = 16
export const MAX_PROMPT_CHARS = 12000
export const MAX_APPROVED = 8
export const MAX_APPROVED_CHARS = 400
/**
 * Judge evidence budget for the pending command. The pending command itself
 * is NEVER clipped before the hard rules and the allowlist run: a decision
 * must see the complete input. When the complete input does not fit this
 * budget, the judge defers to the human instead of judging a prefix.
 */
export const MAX_COMMAND_CHARS = 8000
/** Longer working-directory values are treated as unresolved, never guessed. */
export const MAX_PATH_CHARS = 4096

interface Folded {
  calls: Map<string, BashCall>
  asked: Map<string, { toolName: string; callId?: string }>
  decided: Map<string, string>
  prompts: string[]
  /** Last `working-directory/change` cwd, when the session has one. */
  cwd?: string
}

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

/**
 * Parse one bash arguments payload into a `BashCall`.
 *
 * Direct `tool/call` rows carry the arguments as a JSON string; PTC
 * `tool/ptc-dispatch-start` rows carry the host's normalized JSON object.
 * Both go through here; any other shape, malformed JSON, or a missing
 * command yields undefined — the caller then treats the call as
 * unrecoverable and defers, never guesses.
 */
function parseBashArguments(raw: unknown): BashCall | undefined {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  if (typeof args.command !== 'string') return undefined
  return {
    command: args.command,
    description: typeof args.description === 'string' ? args.description : undefined,
    workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
    sandboxPermissions: typeof args.sandbox_permissions === 'string'
      ? args.sandbox_permissions
      : undefined,
    justification: typeof args.justification === 'string' ? args.justification : undefined,
  }
}

/** Structural identity for the duplicate-id conflict check. */
function sameBashCall(a: BashCall, b: BashCall): boolean {
  return a.command === b.command
    && (a.description ?? '') === (b.description ?? '')
    && (a.workdir ?? '') === (b.workdir ?? '')
    && (a.sandboxPermissions ?? '') === (b.sandboxPermissions ?? '')
    && (a.justification ?? '') === (b.justification ?? '')
}

/**
 * The immutable session header cwd: the project the session was created in.
 * Storage metadata, not an event, and fixtures may omit it; a missing value
 * yields undefined instead of a guessed boundary.
 */
function workspaceOf(session: Session): string | undefined {
  const header = (session as { header?: { cwd?: unknown } }).header
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Validate one path fact against the evidence budget: an over-long value
 * cannot be resolved reliably, so it becomes unknown instead of a prefix.
 */
function boundedPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  return value.length > MAX_PATH_CHARS ? undefined : value
}

/**
 * The directory the host will run the call in, resolved exactly like
 * `resolveWorkdir` in dsh-tool-bash: missing workdir → effective cwd;
 * relative workdir → joined to the effective cwd; absolute workdir → as-is.
 */
function resolveWorkdir(
  workdir: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (cwd === undefined) return undefined
  if (workdir === undefined) return cwd
  if (workdir.length > MAX_PATH_CHARS) return undefined
  return isAbsolute(workdir) ? workdir : `${cwd}${sep}${workdir}`
}

/**
 * Claim one execution id from a `tool/call` / `tool/ptc-dispatch-start` row.
 *
 * Ids are unique per execution in a healthy log, so a SECOND record under an
 * id — whatever its shape — means the log no longer pins down one command:
 *
 * - the only benign duplicate is an idempotent replay of the identical bash
 *   record (kept);
 * - a bash record that disagrees with the stored one, a bash payload that
 *   does not parse (missing command, wrong types, …), or a record naming
 *   another tool taints the id permanently — the entry is dropped and can
 *   never yield evidence again, because an approval must never guess which
 *   of the contradicting records the id refers to.
 */
function claimCall(
  calls: Map<string, BashCall>,
  tainted: Set<string>,
  id: string,
  bash: boolean,
  parsed: BashCall | undefined,
): void {
  if (!bash || parsed === undefined) {
    calls.delete(id)
    tainted.add(id)
    return
  }
  if (tainted.has(id)) return
  const existing = calls.get(id)
  if (existing === undefined) {
    calls.set(id, parsed)
    return
  }
  if (!sameBashCall(existing, parsed)) {
    calls.delete(id)
    tainted.add(id)
  }
}

function fold(events: readonly SessionEvent[]): Folded {
  const calls = new Map<string, BashCall>()
  const tainted = new Set<string>()
  const asked = new Map<string, { toolName: string; callId?: string }>()
  const decided = new Map<string, string>()
  const prompts: string[] = []
  let cwd: string | undefined
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    // The pinned dsh-session types predate `tool/ptc-dispatch-start`; the
    // live host appends it, so dispatch on the widened string and ignore
    // unknown types as before.
    const type: string = event.type
    switch (type) {
      case 'tool/call': {
        if (typeof data.callId !== 'string' || typeof data.name !== 'string') break
        claimCall(
          calls,
          tainted,
          data.callId,
          data.name === 'bash',
          data.name === 'bash' ? parseBashArguments(data.arguments) : undefined,
        )
        break
      }
      case 'tool/ptc-dispatch-start': {
        if (typeof data.subCallId !== 'string' || typeof data.name !== 'string') break
        claimCall(
          calls,
          tainted,
          data.subCallId,
          data.name === 'bash',
          data.name === 'bash' ? parseBashArguments(data.arguments) : undefined,
        )
        break
      }
      case 'approval/asked': {
        if (typeof data.id !== 'string') break
        asked.set(data.id, {
          toolName: typeof data.toolName === 'string' ? data.toolName : '',
          callId: typeof data.callId === 'string' ? data.callId : undefined,
        })
        break
      }
      case 'approval/decided': {
        if (typeof data.id !== 'string' || typeof data.outcome !== 'string') break
        decided.set(data.id, data.outcome)
        break
      }
      case 'working-directory/change': {
        if (typeof data.cwd === 'string' && data.cwd !== '') cwd = data.cwd
        break
      }
      case 'user/message': {
        const message = data as unknown as {
          source?: { kind?: unknown }
          content?: unknown
        }
        if (message.source?.kind !== 'user') break
        if (!Array.isArray(message.content)) break
        const text = textOf(message.content).trim()
        if (text !== '') prompts.push(text)
        break
      }
      default:
        break
    }
  }
  return { calls, asked, decided, prompts, ...(cwd === undefined ? {} : { cwd }) }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…[truncated]' : text
}

/**
 * Fold one session's log into the judge evidence for a pending call.
 *
 * @param session - the requesting agent's live session.
 * @param callId - the pending approval's tool call id.
 * @param effectiveCwd - the host's committed current directory for this
 *   session (`ctx.workingDirectory.get(session)`), when available. The log's
 *   last `working-directory/change` is the fallback; the immutable header is
 *   the last resort. Never substituted for the effective directory.
 * @returns the bounded evidence bundle. The pending command is returned in
 *   full: hard rules and the allowlist must see the entire input. Only the
 *   judge path applies the evidence budget, and it defers over-budget input.
 */
export function collectEvidence(
  session: Session,
  callId: string,
  effectiveCwd?: string,
): Evidence {
  const { calls, asked, decided, prompts, cwd } = fold(session.snapshotEvents())

  // Prior allowed bash calls, in log order (asked/decided pairs are appended
  // in order, so iterating `asked` preserves insertion order).
  const approved: string[] = []
  for (const [id, ask] of asked) {
    if (ask.toolName !== 'bash' || ask.callId === undefined) continue
    if (decided.get(id) !== 'allowed-once') continue
    const call = calls.get(ask.callId)
    if (call === undefined) continue
    approved.push(call.command)
  }

  const pending = calls.get(callId)
  const repeatSources: string[] = []
  if (pending !== undefined) {
    // Exact-repeat memory: the same command escalated to the same mode was
    // already allowed in this session (the pending ask itself excluded).
    // Collect every matching prior approval's call id so the listener can
    // decide per-source whether it may be replayed.
    const mode = pending.sandboxPermissions ?? ''
    for (const [id, ask] of asked) {
      if (ask.toolName !== 'bash' || ask.callId === undefined) continue
      if (callId === ask.callId) continue // the pending ask itself
      if (decided.get(id) !== 'allowed-once') continue
      const prior = calls.get(ask.callId)
      if (prior === undefined) continue
      if (prior.command === pending.command
        && (prior.sandboxPermissions ?? '') === mode) {
        repeatSources.push(ask.callId)
      }
    }
  }

  // The pending call's full arguments (description/justification included)
  // come from the same unified index — one snapshot, one id, whether the
  // host dispatched the call directly or through PTC.
  const call = pending

  // The immutable project boundary and the recorded effective directory are
  // different facts: the host runs the call in the effective cwd (resolved
  // against the call's workdir), which may have moved outside the project.
  const workspace = boundedPath(workspaceOf(session))
  // A provided host value is authoritative even when it is over-long (then
  // the boundary is unknown, not a different fallback).
  const currentCwd = effectiveCwd !== undefined
    ? boundedPath(effectiveCwd)
    : cwd !== undefined
      ? boundedPath(cwd)
      : workspace

  const promptWindow: string[] = []
  let budget = MAX_PROMPT_CHARS
  for (let i = prompts.length - 1; i >= 0 && promptWindow.length < MAX_PROMPTS; i -= 1) {
    const text = prompts[i]
    if (text === undefined) break
    if (text.length > budget) {
      promptWindow.unshift(text.slice(0, Math.max(budget, 0)) + '…[truncated]')
      break
    }
    budget -= text.length
    promptWindow.unshift(text)
  }

  return {
    call: call === undefined ? undefined : {
      ...call,
      ...(call.workdir === undefined
        ? {}
        : { workdir: clip(call.workdir, MAX_PATH_CHARS) }),
    },
    workspace,
    effectiveCwd: currentCwd,
    resolvedWorkdir: resolveWorkdir(call?.workdir, currentCwd),
    prompts: promptWindow,
    approved: approved.slice(-MAX_APPROVED).map((command) => clip(command, MAX_APPROVED_CHARS)),
    exactRepeat: repeatSources.length > 0,
    exactRepeatSources: repeatSources,
  }
}
