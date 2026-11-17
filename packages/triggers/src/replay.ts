/**
 * Pure folding of session-log events into the live caches the turn-end automation consumes, plus a log scanner used by restart recovery.
 * @module dsh-triggers/replay
 */
import { isRecord } from './record.js'
/** Live per-session caches the automation consumes at `turn/end`. */
export interface SessionFold {
  currentTurn?: number
  lastReply?: { turn: number; text: string }
  goalActive: boolean
}

/** The minimal event envelope this module reads (the host `SessionEvent` shape). */
export interface ReplayableEvent {
  readonly type: string
  readonly data: unknown
}

/** Pull the plain text out of one message content block list (join with newlines). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const blocks: unknown[] = content
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    if (!('type' in block) || !('text' in block)) continue
    const { type, text } = block
    if (type === 'text' && typeof text === 'string' && text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}

/** An empty fold: no open turn, no reply, no goal. */
export function emptyFold(): SessionFold {
  return { goalActive: false }
}

/** Fold ONE event into `fold` (mutating it). Handles `turn/start`, `assistant/message`, `goal/change`, and `turn/end`; everything else is a no-op. A `turn/end` consumes the tracked reply and closes the turn, so a replay of the same event can never re-deliver the same final answer. */
export function foldEvent(fold: SessionFold, event: ReplayableEvent): void {
  if (event.type === 'turn/start') {
    const data = isRecord(event.data) ? event.data : undefined
    const turn = data?.turn
    if (typeof turn === 'number') fold.currentTurn = turn
    return
  }
  if (event.type === 'assistant/message') {
    const data = isRecord(event.data) ? event.data : undefined
    const message = isRecord(data?.message) ? data.message : undefined
    const turn = data?.turn
    if (typeof turn !== 'number') return
    fold.lastReply = { turn, text: contentText(message?.content) }
    return
  }
  if (event.type === 'goal/change') {
    const data = isRecord(event.data) ? event.data : undefined
    const goal = isRecord(data?.goal) ? data.goal : undefined
    fold.goalActive = data?.operation !== 'clear' && goal?.phase === 'active'
    return
  }
  if (event.type === 'turn/end') {
    const data = isRecord(event.data) ? event.data : undefined
    const turn = data?.turn
    if (typeof turn === 'number') {
      delete fold.currentTurn
      if (fold.lastReply?.turn === turn) delete fold.lastReply
    }
  }
}

/** One `turn/end` the scanner derived, with the point-in-time context it ended in. */
export interface TurnEndFact {
  readonly turn: number
  readonly reasonKind: string
  readonly time: number
  readonly reply: { turn: number; text: string } | undefined
  readonly goalActive: boolean
}

/** Scan a whole durable session log: every `turn/end` with the context it ended in, plus the fold over the full log (the caches a live listener would hold once caught up). Facts come out in log order. */
export function scanTurnEnds(events: readonly ReplayableEvent[]): {
  facts: TurnEndFact[]
  final: SessionFold
} {
  const fold = emptyFold()
  const facts: TurnEndFact[] = []
  for (const event of events) {
    if (event.type === 'turn/end') {
      const data = isRecord(event.data) ? event.data : undefined
      const reason = isRecord(data?.reason) ? data.reason : undefined
      const turn = data?.turn
      const reasonKind = reason?.kind
      const time = 'time' in event ? event.time : undefined
      if (typeof turn === 'number' && typeof reasonKind === 'string') {
        const tracked = fold.lastReply
        facts.push({
          turn,
          reasonKind,
          time: typeof time === 'number' ? time : 0,
          reply: tracked !== undefined && tracked.turn === turn ? tracked : undefined,
          goalActive: fold.goalActive,
        })
      }
    }
    foldEvent(fold, event)
  }
  return { facts, final: fold }
}
