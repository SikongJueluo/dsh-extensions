import type { ComponentType, ReactNode } from 'react'

/** Host client services read through `ctx.get`. A plugin that reads another host service registers it here (module augmentation) so the accessor stays typed instead of falling back to `unknown`. */
export interface DshClientServices {
  readonly uiWorkspace?: WorkspaceClientLike
  readonly connection?: ConnectionClientLike
}

/** The connection surface a notice consumer reads: one identity per established Host generation. `subscribe` fires on establishment, replacement, and loss, which is the page-level "reconnected" signal - the browser's `online` event is not a DSH reconnection. */
export interface ConnectionClientLike {
  readonly generation: {
    getSnapshot(): { readonly id: number } | undefined
    subscribe(listener: () => void): () => void
  }
}

/** The host workspace UI client surface this repo calls. */
export interface WorkspaceClientLike {
  openSession?(sessionId: string): unknown
  pickDirectory?(): unknown
}

/** One named logger facade from the client Cordis logger service. */
export interface ClientLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** The client runtime's `ctx.logger` service: callable for a named logger. */
export interface ClientLoggerService extends ClientLogger {
  (name?: string): ClientLogger
}

export interface DshClientContext {
  effect(effect: () => unknown, label?: string): void
  get<K extends keyof DshClientServices>(name: K): DshClientServices[K]
  logger: ClientLoggerService
  slots: SlotsService
  locale: LocaleService
  remote: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
}

export interface SlotsService {
  inject(name: string, register: () => void): void
  register(options: SlotRegistration, component: ComponentType<never>): void
}

export interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  priority?: number
  label?: string | (() => ReactNode)
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
