/**
 * The in-flight handoff record and the runtime it runs against.
 *
 * @module dsh-handoff/pending
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelChoice, PresetChoice } from './choice.js'
import type { Config } from './index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HandoffChannel } from './channel.js'
import type { PreferenceStore } from './preferences.js'
import type { HandoffTarget } from './workspace.js'

/** One in-flight handoff, keyed by the origin agent's session id. */
export interface PendingHandoff {
  /** The agent (and session) that writes the brief. */
  readonly agent: Agent
  /** Absolute origin workspace cwd the brief is written under. */
  readonly cwd: string
  /** Where the fresh session spawns (origin cwd or a picked workspace). */
  readonly target: HandoffTarget
  /** True when the target lies outside the origin workspace. */
  readonly crossWorkspace: boolean
  /** Absolute path the brief must be written to (always origin-side). */
  readonly briefPath: string
  /** The verbatim task description from the command line. */
  readonly task: string
  /**
   * Who the brief's context came from. Fresh handoffs leave it unset (the
   * origin agent is the source); retries set it from the sidecar meta so the
   * bootstrap prompt stays truthful when a different session picks up.
   */
  readonly originLabel?: string
  /** Model route chosen in the dialog or via --model. */
  readonly choice: ModelChoice
  /**
   * Preset intent for the fresh session. Independent of {@link choice}: the
   * default inherits the origin session's live preset, and an explicit pick
   * rides this attempt (and its retry) only — it is not remembered as a
   * default for later handoffs.
   */
  readonly preset: PresetChoice
  /**
   * Whether {@link choice} may become the remembered default once the fresh
   * session exists. A `--model` flag is a one-off override and never
   * overwrites the long-term preference.
   */
  readonly rememberModel: boolean
  /**
   * The auto-review opt-in: bind a dsh-triggers loop (this origin reviews,
   * the fresh session executes) before the first prompt. Absent = plain
   * handoff, exactly the pre-review behavior.
   */
  readonly review?: { readonly maxRounds: number }
  /** Epoch milliseconds when the command ran. */
  readonly startedAt: number
  /** Stops the watch (idempotent). Assigned by {@link startHandoffWatch}. */
  stop: () => void
}

/** Per-apply plugin state. */
export interface HandoffRuntime {
  readonly ctx: Context
  readonly config: Config
  /** Resolved config derived once, in chars. */
  readonly maxBriefChars: number
  /** Resolved config derived once, in ms. */
  readonly timeoutMs: number
  /** Resolved config derived once, in ms. */
  readonly pollMs: number
  /** How long the browser's model picker may stay open before the command gives up (ms). */
  readonly pickTimeoutMs: number
  readonly notifyFailure: boolean
  /** In-flight handoffs keyed by origin session id. */
  readonly pending: Map<string, PendingHandoff>
  /** Browser pick channel; absent only when the composition has no connection/web server. */
  readonly channel?: HandoffChannel
  /** Durable remembered model; absent only when the plugin was built without it. */
  readonly preferences?: PreferenceStore
}
