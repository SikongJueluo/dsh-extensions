/**
 * Session-log evidence for one approval request.
 *
 * Everything the judge sees is folded from the requesting session's own event
 * log (`Session.snapshotEvents()`): the exact `tool/call` arguments for the
 * pending call (bash command + description + escalation request), the user
 * prompts (`user/message` with a human source), and this session's prior
 * approval decisions (`approval/asked`/`approval/decided` pairs — the
 * service's own audit trail, so the "approved before" memory needs no
 * dedicated storage).
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Parsed arguments of one bash tool call, as the model produced them. */
export interface BashCall {
  command: string
  description?: string
  sandboxPermissions?: string
  justification?: string
}

/** The evidence bundle handed to the judge prompt builder. */
export interface Evidence {
  /** The pending call's parsed arguments; undefined when not recoverable. */
  call: BashCall | undefined
  /** Human-authored prompts, oldest first, bounded. */
  prompts: readonly string[]
  /** Commands this session already had allowed (bash), newest last, bounded. */
  approved: readonly string[]
  /** Exact-repeat memory: same command + escalation mode already allowed. */
  exactRepeat: boolean
}

/** Upper bounds mirroring the pi ai-bash-judge calibration (evidence windows). */
export const MAX_PROMPTS = 16
export const MAX_PROMPT_CHARS = 12000
export const MAX_APPROVED = 8
export const MAX_APPROVED_CHARS = 400
export const MAX_COMMAND_CHARS = 8000

interface ParsedBashCall {
  name: string
  command: string
  sandboxPermissions?: string
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

function parseBashArguments(raw: string): BashCall | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  if (typeof args.command !== 'string') return undefined
  return {
    command: args.command,
    description: typeof args.description === 'string' ? args.description : undefined,
    sandboxPermissions: typeof args.sandbox_permissions === 'string'
      ? args.sandbox_permissions
      : undefined,
    justification: typeof args.justification === 'string' ? args.justification : undefined,
  }
}

function fold(events: readonly SessionEvent[]): {
  calls: Map<string, ParsedBashCall>
  asked: Map<string, { toolName: string; callId?: string }>
  decided: Map<string, string>
  prompts: string[]
} {
  const calls = new Map<string, ParsedBashCall>()
  const asked = new Map<string, { toolName: string; callId?: string }>()
  const decided = new Map<string, string>()
  const prompts: string[] = []
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    switch (event.type) {
      case 'tool/call': {
        if (typeof data.callId !== 'string' || typeof data.name !== 'string'
          || typeof data.arguments !== 'string') break
        if (data.name !== 'bash') break
        const parsed = parseBashArguments(data.arguments)
        if (parsed === undefined) break
        calls.set(data.callId, {
          name: data.name,
          command: parsed.command,
          sandboxPermissions: parsed.sandboxPermissions,
        })
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
  return { calls, asked, decided, prompts }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…[truncated]' : text
}

/**
 * Fold one session's log into the judge evidence for a pending call.
 *
 * @param session - the requesting agent's live session.
 * @param callId - the pending approval's tool call id.
 * @returns the bounded evidence bundle.
 */
export function collectEvidence(session: Session, callId: string): Evidence {
  const { calls, asked, decided, prompts } = fold(session.snapshotEvents())

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
  let exactRepeat = false
  if (pending !== undefined) {
    // Exact-repeat memory: the same command escalated to the same mode was
    // already allowed in this session (the pending ask itself excluded).
    const mode = pending.sandboxPermissions ?? ''
    for (const [id, ask] of asked) {
      if (ask.toolName !== 'bash' || ask.callId === undefined) continue
      if (callId === ask.callId) continue // the pending ask itself
      if (decided.get(id) !== 'allowed-once') continue
      const prior = calls.get(ask.callId)
      if (prior === undefined) continue
      if (prior.command === pending.command
        && (prior.sandboxPermissions ?? '') === mode) {
        exactRepeat = true
        break
      }
    }
  }

  // The pending call's full arguments (description/justification included)
  // come from a second scan of the log for the exact callId event.
  let call: BashCall | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/call') continue
    const data = event.data as Record<string, unknown>
    if (data.callId === callId && typeof data.arguments === 'string') {
      call = parseBashArguments(data.arguments)
      break
    }
  }

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
    call: call === undefined ? undefined : { ...call, command: clip(call.command, MAX_COMMAND_CHARS) },
    prompts: promptWindow,
    approved: approved.slice(-MAX_APPROVED).map((command) => clip(command, MAX_APPROVED_CHARS)),
    exactRepeat,
  }
}
