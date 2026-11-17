/**
 * The in-flight handoff record and the runtime it runs against.
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
  readonly agent: Agent
  readonly cwd: string
  readonly target: HandoffTarget
  readonly crossWorkspace: boolean
  readonly briefPath: string
  readonly task: string
  readonly originLabel?: string
  readonly choice: ModelChoice
  readonly preset: PresetChoice
  readonly rememberModel: boolean
  readonly review?: { readonly maxRounds: number }
  readonly startedAt: number
  stop: () => void
}

/** Per-apply plugin state. */
export interface HandoffRuntime {
  readonly ctx: Context
  readonly config: Config
  readonly maxBriefChars: number
  readonly timeoutMs: number
  readonly pollMs: number
  readonly pickTimeoutMs: number
  readonly notifyFailure: boolean
  readonly pending: Map<string, PendingHandoff>
  readonly channel?: HandoffChannel
  readonly preferences?: PreferenceStore
}
