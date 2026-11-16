/**
 * The two choices a handoff carries: which model route and which preset the
 * fresh session inherits. Parsed from untrusted browser payloads and sidecar
 * JSON, so both come with a narrowing helper.
 *
 * @module dsh-handoff/choice
 */

/** Which model route the fresh session should use. */
export type ModelChoice =
  | { kind: 'inherit' }
  | { kind: 'default' }
  | { kind: 'model'; provider: string; model: string; reasoningEffort?: string }

/** Narrow an untrusted value (browser payload, sidecar meta JSON) into a choice. */
export function coerceModelChoice(value: unknown): ModelChoice | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'inherit') return { kind: 'inherit' }
  if (record.kind === 'default') return { kind: 'default' }
  if (record.kind === 'model') {
    const provider = record.provider
    const model = record.model
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof model !== 'string' || model.length === 0) return undefined
    const effort = record.reasoningEffort
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
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'inherit') return { kind: 'inherit' }
  if (record.kind === 'preset' && typeof record.id === 'string' && record.id.length > 0) {
    return { kind: 'preset', id: record.id }
  }
  return undefined
}
