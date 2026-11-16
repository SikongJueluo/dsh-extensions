/**
 * Extract the pending batch from a session event snapshot.
 *
 * The host appends `tool/call` events ONE CALL AT A TIME as it starts each
 * execution, so the event tail cannot show the whole batch at the first
 * `tools/pre-execute`. The complete batch is instead already settled in the
 * current step's `assistant/message` — its `message.content` carries every
 * `tool-call` block (id, name, raw arguments) the model requested, and that
 * message is appended before dispatch begins. This module reads exactly that
 * public shape; it never touches scheduler internals.
 *
 * When no assistant message with tool-call blocks can be found (unusual
 * orderings, exotic transports), the caller falls back to checking the live
 * execution alone — whole-batch atomicity is then explicitly NOT claimed.
 *
 * @module dsh-execution-guard/batch
 */
/**
 * The event fields this module reads. The host's own `SessionEvent` satisfies
 * it, and a test can fabricate one without pretending to be a full host event.
 */
export interface StepEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/** One extracted sibling call (raw model JSON string, unparsed). */
export interface StepToolCall {
  readonly callId: string
  readonly tool: string
  readonly argsRaw: string
}

/** Highest seq of a human `user/message` event in the snapshot, or -1. */
export function lastHumanSeq(events: readonly StepEvent[]): number {
  let found = -1
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = isRecord(event.data) ? event.data.source : undefined
    if (isRecord(source) && source.kind === 'user') found = event.seq
  }
  return found
}

/**
 * Collect the CURRENT batch: the tool-call blocks of the last
 * `assistant/message` that contains any, in block order.
 *
 * @param events - the full session snapshot.
 * @returns the pending batch's calls; empty when no assistant tool-call
 * message exists (caller then checks only the live execution).
 */
/** Narrow an untyped event payload to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function currentStepCalls(events: readonly StepEvent[]): StepToolCall[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || event.type !== 'assistant/message') continue
    const data: unknown = event.data
    const message = isRecord(data) ? data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content)) continue
    const calls: StepToolCall[] = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type !== 'tool-call') continue
      if (
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        typeof block.arguments !== 'string'
      ) {
        continue
      }
      calls.push({ callId: block.id, tool: block.name, argsRaw: block.arguments })
    }
    if (calls.length > 0) return calls
    // An assistant message without tool calls ends the search: nothing later
    // in the log can be part of a pending batch.
    return []
  }
  return []
}
