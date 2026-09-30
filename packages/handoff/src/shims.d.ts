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

/** Minimal `ctx.agentPresets` surface used by the spawn path. */
export interface AgentPresetsShim {
  /** Resolve the preset id composed into an agent context, if any. */
  composedPreset(agentCtx: Context): string | undefined
  /** Resolve a preset id (undefined = the deployment default) to its stable id. */
  resolve(id?: string): Promise<{ id: string }>
  /** Mount a preset's composition into an (unpublished) agent context. */
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Minimal `ctx.agentDefaultModel` surface used for the "global default" choice. */
export interface AgentDefaultModelShim {
  /** The deployment default: provider, model, and its reasoning effort when set. */
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present in compositions that mount the preset registry (the stock web profile does). */
    agentPresets?: AgentPresetsShim
    /** Present in compositions that mount the default-model selection service. */
    agentDefaultModel?: AgentDefaultModelShim
  }
}
