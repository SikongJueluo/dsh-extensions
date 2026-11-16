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
export interface DshClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get<T = unknown>(name: string): T
  slots: SlotsService
  locale: LocaleService
  remote: Record<string, any>
}

export interface SlotsService {
  inject(name: string, register: () => void): void
  register(options: SlotRegistration, component: ComponentType<any>): void
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
  inject?: (...args: any[]) => Record<string, unknown>
  locale?: string
}

export interface LocaleService {
  register(
    namespace: string,
    dictionaries: { zh: Record<string, string>; en: Record<string, string> },
  ): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}
