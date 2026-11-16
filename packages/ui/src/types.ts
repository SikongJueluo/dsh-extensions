import type { ComponentType, ReactNode } from 'react'

/**
 * The client-half context DSH hands to `apply`.
 *
 * The host publishes no browser-half TypeScript package for this surface, so
 * the members we rely on are pinned here to the documented loader contract:
 * `effect` owns cleanup, `slots` registers into an existing slot, `locale`
 * registers/binds dictionaries, and `remote` is the generated typed-remote
 * object (left open because its shape comes from the host package the plugin
 * declares in `dsh.client.inject`).
 */
/**
 * Host client services read through `ctx.get`. A plugin that reads another
 * host service registers it here (module augmentation) so the accessor stays
 * typed instead of falling back to `unknown`.
 */
export interface DshClientServices {
  /** Host workspace UI client (`dsh-client-ui-workspace`), when mounted. */
  readonly uiWorkspace?: WorkspaceClientLike
}

/** The host workspace UI client surface this repo calls. */
export interface WorkspaceClientLike {
  openSession?(sessionId: string): unknown
  pickDirectory?(): unknown
}

export interface DshClientContext {
  effect(effect: () => unknown, label?: string): void
  get<K extends keyof DshClientServices>(name: K): DshClientServices[K]
  slots: SlotsService
  locale: LocaleService
  /**
   * The host's generated typed-remote object. Its shape comes from the host
   * package a plugin declares in `dsh.client.inject`, so this declaration can
   * only promise "callable services resolving to unknown"; each call site
   * still annotates the envelope it expects.
   */
  remote: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
}

export interface SlotsService {
  inject(name: string, register: () => void): void
  register(options: SlotRegistration, component: ComponentType<never>): void
}

export interface SlotRegistration {
  name: string
  /** Entry key for id-addressed slots. */
  id?: string
  /** Entry key for keyed slots (`main`, keyed context menus). */
  key?: string
  order?: number
  /** Lower numbers claim the slot first; used by replacement controls. */
  priority?: number
  label?: string | (() => ReactNode)
  /** Slot-owner context (for example the current session id) may be passed in. */
  inject?: (...args: never[]) => Record<string, unknown>
  locale?: string
}

export interface LocaleService {
  register(
    namespace: string,
    dictionaries: { zh: Record<string, string>; en: Record<string, string> },
  ): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}
