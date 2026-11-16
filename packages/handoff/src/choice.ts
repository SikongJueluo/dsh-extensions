/**
 * The two choices a handoff carries: which model route and which preset the
 * fresh session inherits. Parsed from untrusted browser payloads and sidecar
 * JSON, so both come with a narrowing helper.
 *
 * @module dsh-handoff/choice
 */

/** Prove a value is a plain object record before reading its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Which model route the fresh session should use. */
export type ModelChoice =
  | { kind: 'inherit' }
  | { kind: 'default' }
  | { kind: 'model'; provider: string; model: string; reasoningEffort?: string }

/** Narrow an untrusted value (browser payload, sidecar meta JSON) into a choice. */
export function coerceModelChoice(value: unknown): ModelChoice | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'inherit') return { kind: 'inherit' }
  if (value.kind === 'default') return { kind: 'default' }
  if (value.kind === 'model') {
    const provider = value.provider
    const model = value.model
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof model !== 'string' || model.length === 0) return undefined
    const effort = value.reasoningEffort
    if (effort !== undefined && (typeof effort !== 'string' || effort.length === 0))
      return undefined
    return {
      kind: 'model',
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  }
  return undefined
}

/**
 * Which agent preset the fresh session should mount. Separate from the model
 * choice on purpose: the two must combine freely ("inherit preset + a cheaper
 * remembered model" is the common case). `inherit` means the origin session's
 * live preset — or no preset at all when the origin runs none; it never means
 * the deployment default.
 */
export type PresetChoice = { kind: 'inherit' } | { kind: 'preset'; id: string }

/** Narrow an untrusted value (browser payload, sidecar meta JSON) into a preset choice. */
export function coercePresetChoice(value: unknown): PresetChoice | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'inherit') return { kind: 'inherit' }
  if (value.kind === 'preset' && typeof value.id === 'string' && value.id.length > 0) {
    return { kind: 'preset', id: value.id }
  }
  return undefined
}
