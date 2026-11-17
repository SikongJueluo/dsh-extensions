/**
 * Audit persistence: the full record of one research run goes to the spill store (session-scoped, owner-only) and the result carries back only the opaque locator plus retrieval guidance.
 * @module dsh-search-integrator/audit
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AuditRef } from './types.js'
import { isRecord } from './types.js'

/** Identity the audit artifact is filed under. */
export interface AuditOwner {
  readonly toolName: string
  readonly callId: ToolCallId
  readonly sessionId?: string
}

/** The port the pipeline consumes. */
export interface AuditPort {
  save(payload: string, suggestedName: string): Promise<AuditRef | undefined>
}

/** The `saveText` shape the pipeline needs from the spill store service. */
interface SpillStorePort {
  saveText(input: {
    owner: { sessionId: string }
    source: { kind: 'tool'; toolName: string; callId: ToolCallId; label: string }
    suggestedName: string
    content: string
  }): Promise<{ locator: { toString(): string }; bytes: number; retrievalHint: string }>
}

function isSpillStore(value: unknown): value is SpillStorePort {
  return isRecord(value) && typeof value.saveText === 'function'
}

/**
 * The real port over the optional `ctx.spillStore` service.
 * @param ctx - plugin context (`spillStore` resolved opportunistically).
 * @param owner - tool-call identity for the artifact.
 */
export function createAuditPort(ctx: Context, owner: AuditOwner): AuditPort {
  return {
    async save(payload, suggestedName) {
      const service: unknown = ctx.get('spillStore')
      const store = isSpillStore(service) ? service : undefined
      if (store === undefined) return undefined
      if (owner.sessionId === undefined) return undefined
      try {
        const ref = await store.saveText({
          owner: { sessionId: owner.sessionId },
          source: { kind: 'tool', toolName: owner.toolName, callId: owner.callId, label: 'audit' },
          suggestedName,
          content: payload,
        })
        return {
          locator: String(ref.locator),
          retrievalHint: ref.retrievalHint,
          bytes: ref.bytes,
        }
      } catch (error) {
        ctx.logger.warn(
          'search-integrator: audit save failed (continuing without audit): %o',
          error,
        )
        return undefined
      }
    },
  }
}

/** An audit port that never persists (tests, or audit disabled). */
export function createNullAuditPort(): AuditPort {
  return {
    async save() {
      return undefined
    },
  }
}
