/**
 * The allowlist configuration (dsh 0.2 settings model).
 *
 * The row's `Config` schema IS the Settings form: `@deepseek-ai/dsh-settings`
 * projects every live plugin entry's schema automatically, so the allowlist is
 * editable from the Web Settings page by editing this plugin's own row —
 * namespace `cmd-permit`, the bundle patch's entry id. Every field is
 * `volatile()`, so a Settings edit commits into the running fiber without a
 * remount; the answerer reads the live values through the `Volatile`
 * references on every approval.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Sandbox escalation modes, ordered by width (see rules.MODE_RANK). */
export type MaxMode = 'workspace-write' | 'danger-full-access'

/** Resolved allowlist configuration (live row config). */
export interface CmdPermitSettings {
  /** Master switch; false defers everything to the rest of the chain. */
  enabled: boolean
  /** Command names whose escalations may be auto-allowed. */
  allow: readonly string[]
  /** Extra regex sources; one matching EVERY segment also allows. */
  allowPattern: readonly string[]
  /** User additions to the high-risk shapes (always deferred to the human). */
  denyShape: readonly string[]
  /** Highest escalation mode an allowlisted command may receive. */
  maxMode: MaxMode
}

/** Plugin-row configuration; the Settings form edits these fields live. */
export interface Config {
  enabled: Volatile<boolean>
  allow: Volatile<readonly string[]>
  allowPattern: Volatile<readonly string[]>
  denyShape: Volatile<readonly string[]>
  maxMode: Volatile<MaxMode>
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 types volatile modes
// into the schema generics, and an annotation would fight the inference the
// loader validates `Config` against.
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile().description(
    'Master switch. When off, every approval falls through to the rest of the chain (e.g. the auto-permit judge).',
  ),
  allow: Schema.array(Schema.string()).default([]).volatile().description(
    'Command names that may be auto-allowed when they escalate the sandbox (e.g. rtk, cargo, direnv). A compound command is allowed only when every segment is covered by an entry here or in allowPattern.',
  ),
  allowPattern: Schema.array(Schema.string()).default([]).volatile().description(
    'Regex sources (e.g. "^gh pr (list|view)"). One pattern matching every segment of the command also allows it; invalid regexes are ignored with a warning.',
  ),
  denyShape: Schema.array(Schema.string()).default([]).volatile().description(
    'Regex sources added to the built-in high-risk shapes; a hit always defers to the human answerer, both here and in the auto-permit judge (when that plugin is also mounted).',
  ),
  maxMode: Schema.union(['workspace-write', 'danger-full-access']).default('danger-full-access').volatile().description(
    'Highest sandbox mode an allowlisted command may be auto-escalated to; a wider request defers to the human.',
  ),
})

/**
 * Return the live settings reader.
 *
 * @param _ctx - plugin context.
 * @param config - composition row config (volatile live references).
 * @returns a thunk reading the currently authoritative settings value.
 */
export function registerSettings(_ctx: Context, config: Config): () => CmdPermitSettings {
  return () => ({
    enabled: config.enabled.get(),
    allow: config.allow.get(),
    allowPattern: config.allowPattern.get(),
    denyShape: config.denyShape.get(),
    maxMode: config.maxMode.get(),
  })
}
