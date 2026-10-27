/**
 * Local type shims for host services this plugin consumes optionally through
 * `ctx.get()` but whose packages are not published to npm as standalone type
 * entry points (or whose augmentation we do not want to hard-depend on).
 *
 * Everything here is type-only and erased at build time.
 *
 * @module dsh-handoff/shims
 */
import type { Context } from '@deepseek-ai/cordis'

/** One declared preset as the registry reports it (activation failures included). */
export interface AgentPresetSummary {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  /** Why the preset cannot compose a session; absent when it can. */
  readonly broken?: string
}

/** Minimal `ctx.agentPresets` surface used by the selection and spawn paths. */
export interface AgentPresetsShim {
  /** Resolve the preset id composed into an agent context, if any. */
  composedPreset(agentCtx: Context): string | undefined
  /** Every declared preset, including ones whose activation failed. */
  list(): Promise<AgentPresetSummary[]>
  /** Resolve a preset id (undefined = the deployment default) to its current revision. */
  resolve(id?: string): Promise<AgentPresetSummary>
  /** Mount a preset's composition into an (unpublished) agent context. */
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Minimal `ctx.agentDefaultModel` surface used for the "global default" choice. */
export interface AgentDefaultModelShim {
  /** The deployment default: provider, model, and its reasoning effort when set. */
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/**
 * Minimal `ctx.triggerBindings` surface (dsh-triggers). Present when that
 * plugin is mounted; without it the auto-review option degrades to a plain
 * handoff with a visible notice.
 */
export interface TriggerBindingsShim {
  bindReviewLoop(request: {
    task: string
    executorSession: string
    parentSession: string
    maxRounds?: number
    deliverStart?: boolean
    /** Auto-submit the executor's completed turns (handoff passes true). */
    autoDeliver?: boolean
  }): Promise<{ bindingId: string; runId: string }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present in compositions that mount the preset registry (the stock web profile does). */
    agentPresets?: AgentPresetsShim
    /** Present in compositions that mount the default-model selection service. */
    agentDefaultModel?: AgentDefaultModelShim
    /** Present when the dsh-triggers plugin is mounted. */
    triggerBindings?: TriggerBindingsShim
  }
}
