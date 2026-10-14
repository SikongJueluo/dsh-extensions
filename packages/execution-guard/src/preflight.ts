/**
 * Pure argument preflight for one tool call and one native same-step batch.
 *
 * The harness already validates arguments inside `defineTool` execution; this
 * module moves the SAME check in front of approval and side effects by
 * re-using the public registry surface (`ctx.tools.schemas`) and the shared
 * enforced-subset validators (`assertSupportedJsonSchema` /
 * `validateJsonSchemaValue`). It never rewrites arguments, never auto-fills,
 * and never widens a decision: the only extra outcome it can produce is a
 * DENY with per-call violations; everything it cannot decide degrades to the
 * host's own behavior with a diagnostic.
 *
 * @module dsh-execution-guard/preflight
 */
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  type JsonSchemaNode,
} from '@deepseek-ai/dsh-tools'

/** Model-facing deny code; also the repeat-hint correlation key. */
export const INVALID_ARGS_CODE = 'INVALID_ARGS'
/** Diagnostic-namespace name carried on every denial this module issues. */
export const GUARD_NAME = 'execution-guard'

/** One candidate call entering preflight; arguments are still raw or parsed. */
export interface PreflightCall {
  readonly tool: string
  readonly callId: string
  /** Losslessly parsed arguments when available (the live execution). */
  readonly args?: unknown
  /** Raw model JSON string when only the durable event is available (siblings). */
  readonly argsRaw?: string
}

/** Per-call outcome: either violations (strings) or why we could not check. */
export type CallVerdict =
  | { kind: 'invalid'; violations: readonly string[] }
  | { kind: 'valid' }
  | { kind: 'unchecked'; why: 'unknown-tool' | 'unsupported-schema' | 'no-schema' }

/** Whole-batch decision for the pre-execute gate. */
export type PreflightDecision =
  | { kind: 'allow' }
  | {
      kind: 'deny'
      reason: string
      /** Every invalid call with its tool/callId, for the deny report. */
      invalid: readonly { tool: string; callId: string; violations: readonly string[] }[]
      /** Unchecked calls kept for diagnostics; they never cause a deny. */
      unchecked: readonly { tool: string; callId: string; why: CallVerdict extends never ? never : 'unknown-tool' | 'unsupported-schema' | 'no-schema' }[]
    }

/** Bounded report text so a huge batch cannot balloon the deny reason. */
const MAX_VIOLATIONS_PER_CALL = 8
const MAX_INVALID_CALLS_IN_REASON = 8
const MAX_REASON_CHARS = 2000

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

/**
 * Validate one call against one raw parameter schema.
 *
 * `assertSupportedJsonSchema` rejects schemas outside the enforced subset
 * rather than trusting them, so an unsupported schema yields `unchecked` —
 * the host's own definition-time validation stays authoritative there and we
 * do not bypass it with a guess.
 *
 * @param parameters - raw `parameters` of a public tool schema (untrusted).
 * @param call - the candidate call (parsed args preferred, else raw JSON).
 * @returns the per-call verdict.
 */
export function checkCall(parameters: unknown, call: PreflightCall): CallVerdict {
  let schema: JsonSchemaNode
  try {
    assertSupportedJsonSchema(parameters)
    schema = parameters
  } catch (error) {
    void error
    return { kind: 'unchecked', why: 'unsupported-schema' }
  }
  let args: unknown
  if (call.args !== undefined) {
    args = call.args
  } else if (typeof call.argsRaw === 'string') {
    // Mirror the host's raw-argument parse EXACTLY: only the empty string
    // is the legal "no arguments" form (raw === '' -> {}); a blank
    // whitespace string is truthy, fails JSON.parse, and reaches the
    // schema as a parse failure — as it does on the host.
    if (call.argsRaw === '') {
      args = {}
    } else {
      try {
        args = JSON.parse(call.argsRaw)
      } catch {
        return { kind: 'invalid', violations: ['arguments: not valid JSON'] }
      }
    }
  } else {
    return { kind: 'unchecked', why: 'no-schema' }
  }
  if (args === undefined) return { kind: 'unchecked', why: 'no-schema' }
  const violations = validateJsonSchemaValue(schema, args, 'arguments')
  return violations.length === 0 ? { kind: 'valid' } : { kind: 'invalid', violations }
}

/**
 * Decide one whole native same-step batch (and the degenerate single call).
 *
 * Any invalid member denies the batch: the current pre-execute returns the
 * deny, and each sibling's own gate independently reaches the same decision,
 * so no child body runs while its batch-mate is invalid. `unchecked` members
 * (unknown tool, unsupported schema) never deny — the host already treats an
 * unknown native tool as UNKNOWN_TOOL and validates unsupported schemas at
 * the definition layer; inventing a verdict there would be a bypass.
 *
 * @param calls - the batch's calls (see {@link checkCall} for arg forms).
 * @param schemaOf - raw public parameters for a tool name, or undefined.
 * @returns the gate decision; `allow` when nothing checkable is invalid.
 */
export function checkBatch(
  calls: readonly PreflightCall[],
  schemaOf: (tool: string) => unknown | undefined,
): PreflightDecision {
  const invalid: { tool: string; callId: string; violations: readonly string[] }[] = []
  const unchecked: { tool: string; callId: string; why: 'unknown-tool' | 'unsupported-schema' | 'no-schema' }[] = []
  for (const call of calls) {
    const parameters = schemaOf(call.tool)
    let verdict: CallVerdict
    if (parameters === undefined) {
      verdict = { kind: 'unchecked', why: 'unknown-tool' }
    } else {
      verdict = checkCall(parameters, call)
    }
    if (verdict.kind === 'invalid') {
      invalid.push({ tool: call.tool, callId: call.callId, violations: verdict.violations })
    } else if (verdict.kind === 'unchecked') {
      unchecked.push({ tool: call.tool, callId: call.callId, why: verdict.why })
    }
  }
  if (invalid.length === 0) return { kind: 'allow' }
  const lines = invalid.slice(0, MAX_INVALID_CALLS_IN_REASON).map((entry) => {
    const shown = entry.violations.slice(0, MAX_VIOLATIONS_PER_CALL).join('; ')
    const more = entry.violations.length > MAX_VIOLATIONS_PER_CALL
      ? ` (+${entry.violations.length - MAX_VIOLATIONS_PER_CALL} more)`
      : ''
    return `tool "${entry.tool}" (call ${entry.callId}): ${shown}${more}`
  })
  if (invalid.length > MAX_INVALID_CALLS_IN_REASON) {
    lines.push(`(+${invalid.length - MAX_INVALID_CALLS_IN_REASON} more invalid calls)`)
  }
  const reason = clip(
    `${GUARD_NAME}: ${INVALID_ARGS_CODE} — batch rejected before dispatch ` +
      `(${invalid.length} of ${calls.length} call(s) invalid; all members of this batch are denied).\n` +
      lines.join('\n'),
    MAX_REASON_CHARS,
  )
  return { kind: 'deny', reason, invalid, unchecked }
}

/** Shape summary for correction hints; bounded and derived from a raw schema. */
export function describeShape(parameters: unknown): string {
  let schema: JsonSchemaNode
  try {
    assertSupportedJsonSchema(parameters)
    schema = parameters
  } catch {
    return 'parameters schema is outside the enforced subset; see the tool declaration'
  }
  if (schema.type !== 'object' || schema.properties === undefined) {
    return schema.type === undefined ? 'any JSON value' : `a JSON ${schema.type}`
  }
  const parts: string[] = []
  const required = new Set(schema.required ?? [])
  for (const [key, node] of Object.entries(schema.properties)) {
    const type = node.type ?? 'json'
    parts.push(required.has(key) ? `${key}: ${type} (required)` : `${key}: ${type} (optional)`)
  }
  const open = schema.additionalProperties === false ? 'no undeclared keys' : 'undeclared keys allowed'
  return `object — ${parts.length === 0 ? 'no declared properties' : parts.join(', ')}; ${open}`
}
