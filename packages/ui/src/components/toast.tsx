import * as React from 'react'
import { Toast } from '@base-ui/react/toast'
import { X } from 'lucide-react'
import type { ConnectionClientLike } from '../types'
import { cn } from '../lib/cn'
import { Root } from './root'

/** One plugin instance's current state, as the Host status route reports it. */
export interface ConfigInstanceStatus {
  id: number
  title: string
  file: string
  state: 'loading' | 'valid' | 'invalid'
  error?: string
  revision: number
  recovery: 'auto' | 'restart'
}

/** The aggregate status payload for one plugin. */
export interface ConfigStatusPayload {
  instances: ConfigInstanceStatus[]
}

export interface ConfigStatusToastProps {
  /** Same-origin relative URL of the owning plugin's status route. */
  statusUrl: string
  /** Poll interval while the page is visible. @default 5000 */
  pollMs?: number
  /** Host connection generation; a new generation re-announces current errors. */
  connection?: ConnectionClientLike
}

const DEFAULT_POLL_MS = 5_000
const RECOVERY_TIMEOUT_MS = 6_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInstanceStatus(value: unknown): value is ConfigInstanceStatus {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    typeof value.file === 'string' &&
    (value.state === 'loading' || value.state === 'valid' || value.state === 'invalid') &&
    typeof value.revision === 'number' &&
    (value.recovery === 'auto' || value.recovery === 'restart') &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

/** Validate the wire payload; an unrelated or partial response contributes nothing. */
function statusInstances(value: unknown): ConfigInstanceStatus[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.instances)) return undefined
  return value.instances.filter(isInstanceStatus)
}

/**
 * One page-wide notice coordinator, shared by every plugin bundle through a
 * global property. Each plugin's browser half registers its status URL; the
 * first registered component renders the single toast viewport and polls every
 * URL, so two plugins with errors stack their notices instead of covering each
 * other. When that component unmounts, the next registration takes over.
 */
interface NoticeSource {
  url: string
  pollMs: number
}

interface NoticeHub {
  version: number
  sources: Map<symbol, NoticeSource>
  listeners: Set<() => void>
}

declare global {
  var dshExtensionsConfigNoticeHub: NoticeHub | undefined
}

function noticeHub(): NoticeHub {
  globalThis.dshExtensionsConfigNoticeHub ??= {
    version: 0,
    sources: new Map(),
    listeners: new Set(),
  }
  return globalThis.dshExtensionsConfigNoticeHub
}

function notifyHub(hub: NoticeHub): void {
  hub.version += 1
  for (const listener of hub.listeners) listener()
}

function subscribeHub(listener: () => void): () => void {
  const hub = noticeHub()
  hub.listeners.add(listener)
  return () => {
    hub.listeners.delete(listener)
  }
}

function hubVersion(): number {
  return noticeHub().version
}

/**
 * One logical configuration: a plugin's file. Several plugin instances (agent
 * preset generations) can read the same file; they are one notice, and the
 * group is invalid when any instance is invalid.
 */
function groupKey(instance: ConfigInstanceStatus): string {
  return `${instance.title}\u0000${instance.file}`
}

interface GroupState {
  key: string
  title: string
  file: string
  state: 'valid' | 'invalid'
  error?: string
  recovery: 'auto' | 'restart'
  /** Live error toast id, when one is open. */
  toastId?: string
  /** The user closed this generation's error toast and it is still invalid. */
  dismissed: boolean
}

interface IncomingGroup {
  key: string
  title: string
  file: string
  state: 'valid' | 'invalid'
  error?: string
  recovery: 'auto' | 'restart'
  revision: number
}

interface Tracking {
  /** Logical configuration state, keyed by title + file. */
  groups: React.MutableRefObject<Map<string, GroupState>>
  /** Group keys last reported by each status source. */
  groupsBySource: React.MutableRefObject<Map<string, Set<string>>>
}

function errorDescription(group: {
  error?: string
  file: string
  recovery: 'auto' | 'restart'
}): string {
  return `${group.error ?? '未知错误'} — ${group.file}${
    group.recovery === 'auto' ? '；修好后会自动恢复' : '；修好后需重启 dsh'
  }`
}

function ToastList({ onDismiss }: { onDismiss: (key: string) => void }) {
  const { toasts } = Toast.useToastManager()
  return (
    <>
      {toasts.map((toast) => {
        const data: unknown = toast.data
        const key = isRecord(data) && typeof data.key === 'string' ? data.key : undefined
        return (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className={cn(
              'dshx:pointer-events-auto dshx:w-[min(420px,100%)] dshx:rounded-card dshx:border dshx:bg-surface dshx:px-3 dshx:py-2.5 dshx:shadow-lg',
              toast.type === 'error' ? 'dshx:border-danger/40' : 'dshx:border-ok/40',
            )}
          >
            <div className="dshx:flex dshx:items-start dshx:gap-3">
              <div className="dshx:min-w-0 dshx:flex-1">
                <Toast.Title
                  className={cn(
                    'dshx:text-xs dshx:font-medium',
                    toast.type === 'error' ? 'dshx:text-danger' : 'dshx:text-ok',
                  )}
                />
                <Toast.Description className="dshx:mt-1 dshx:text-xs dshx:leading-5 dshx:text-fg-secondary dshx:break-words" />
              </div>
              <Toast.Close
                aria-label="关闭提示"
                onClick={() => {
                  if (key !== undefined) onDismiss(key)
                }}
                className="dshx:-mr-1 dshx:-mt-1 dshx:inline-flex dshx:size-7 dshx:shrink-0 dshx:items-center dshx:justify-center dshx:rounded-control dshx:text-fg-tertiary dshx:hover:bg-surface-2 dshx:hover:text-fg dshx:pointer-coarse:size-11"
              >
                <X className="dshx:size-3.5" aria-hidden="true" />
              </Toast.Close>
            </div>
          </Toast.Root>
        )
      })}
    </>
  )
}

function StatusWatcher({
  sources,
  connection,
  tracking,
}: {
  sources: readonly NoticeSource[]
  connection?: ConnectionClientLike
  tracking: Tracking
}) {
  const { add, close, update } = Toast.useToastManager()
  const { groups, groupsBySource } = tracking

  const openError = React.useCallback(
    (group: GroupState): string => {
      const toastId = add({
        title: `${group.title} 配置错误`,
        description: errorDescription(group),
        type: 'error',
        // A broken config blocks the plugin's work; keep the notice until the
        // user closes it or the file is fixed.
        timeout: 0,
        data: { key: group.key },
        // Covers every close path, including a swipe, not only the button.
        onClose: () => {
          const current = groups.current.get(group.key)
          if (current === undefined || current.toastId !== toastId) return
          current.dismissed = true
          current.toastId = undefined
        },
      })
      return toastId
    },
    [add, groups],
  )

  React.useEffect(() => {
    let cancelled = false

    const applySource = (url: string, instances: readonly ConfigInstanceStatus[]): void => {
      // Collapse every instance into one state per plugin file. Any invalid
      // instance keeps the group invalid; the newest invalid revision owns the
      // message.
      const incoming = new Map<string, IncomingGroup>()
      for (const instance of instances) {
        if (instance.state === 'loading') continue
        const key = groupKey(instance)
        const existing = incoming.get(key)
        if (instance.state === 'invalid') {
          if (
            existing === undefined ||
            existing.state !== 'invalid' ||
            existing.revision < instance.revision
          ) {
            incoming.set(key, {
              key,
              title: instance.title,
              file: instance.file,
              state: 'invalid',
              error: instance.error ?? '未知错误',
              recovery: instance.recovery,
              revision: instance.revision,
            })
          }
        } else if (existing === undefined) {
          incoming.set(key, {
            key,
            title: instance.title,
            file: instance.file,
            state: 'valid',
            recovery: instance.recovery,
            revision: instance.revision,
          })
        }
      }

      // A group that disappeared means the plugin instance unloaded, not that
      // the file became valid: drop its notice without a recovery message.
      for (const key of groupsBySource.current.get(url) ?? []) {
        if (incoming.has(key)) continue
        const previous = groups.current.get(key)
        if (previous?.toastId !== undefined) close(previous.toastId)
        groups.current.delete(key)
      }
      groupsBySource.current.set(url, new Set(incoming.keys()))

      for (const next of incoming.values()) {
        const previous = groups.current.get(next.key)
        if (next.state === 'invalid') {
          const changed = previous?.state === 'invalid' && previous.error !== next.error
          if (previous?.state === 'invalid' && !changed) {
            previous.recovery = next.recovery
            // A new connection generation clears `dismissed`; the next fresh
            // poll is what re-opens the still-current error. A same-generation
            // poll after a manual close stays suppressed.
            if (previous.toastId === undefined && !previous.dismissed) {
              previous.toastId = openError(previous)
            }
            continue
          }
          const group: GroupState = {
            key: next.key,
            title: next.title,
            file: next.file,
            state: 'invalid',
            error: next.error,
            recovery: next.recovery,
            toastId: previous?.toastId,
            dismissed: false,
          }
          if (group.toastId !== undefined) {
            update(group.toastId, { description: errorDescription(group) })
          } else {
            group.toastId = openError(group)
          }
          groups.current.set(next.key, group)
          continue
        }

        // Valid. Only an invalid -> valid transition is a recovery; a plugin
        // that unloads or a message that merely changes is not.
        if (previous?.state === 'invalid') {
          if (previous.toastId !== undefined) close(previous.toastId)
          add({
            title: `${previous.title} 配置已恢复`,
            description: `${previous.file}${
              previous.recovery === 'auto' ? '；新的操作已可用' : '；重启 dsh 后生效'
            }`,
            type: 'success',
            timeout: RECOVERY_TIMEOUT_MS,
          })
        }
        groups.current.set(next.key, {
          key: next.key,
          title: next.title,
          file: next.file,
          state: 'valid',
          recovery: next.recovery,
          dismissed: false,
        })
      }
    }

    const read = async (source: NoticeSource): Promise<void> => {
      try {
        const response = await fetch(source.url, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return
        const payload: unknown = await response.json()
        const instances = statusInstances(payload)
        if (cancelled || instances === undefined) return
        applySource(source.url, instances)
      } catch {
        // Offline, or the route is not mounted yet: keep the last known state
        // and retry on the next poll or connection generation.
      }
    }

    const poll = async (): Promise<void> => {
      await Promise.all(sources.map((source) => read(source)))
    }

    // Drop state for plugins that unloaded; their stale errors must not keep
    // the viewport occupied.
    const urls = new Set(sources.map((source) => source.url))
    for (const url of groupsBySource.current.keys()) {
      if (urls.has(url)) continue
      for (const key of groupsBySource.current.get(url) ?? []) {
        const previous = groups.current.get(key)
        if (previous?.toastId !== undefined) close(previous.toastId)
        groups.current.delete(key)
      }
      groupsBySource.current.delete(url)
    }

    void poll()
    const interval = Math.min(...sources.map((source) => source.pollMs), DEFAULT_POLL_MS)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll()
    }, interval)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    // A new DSH connection generation re-announces errors the user dismissed in
    // the previous one; the browser `online` event is not that signal.
    // Only a newly established generation is a reconnect. The connection
    // controller publishes `undefined` on loss and while reconnecting; reacting
    // to that would replay cached errors before the fresh status is known.
    let lastGeneration = connection?.generation.getSnapshot()?.id
    const stopGeneration =
      connection?.generation.subscribe(() => {
        const snapshot = connection.generation.getSnapshot()
        if (snapshot === undefined || snapshot.id === lastGeneration) return
        lastGeneration = snapshot.id
        for (const group of groups.current.values()) group.dismissed = false
        // Do not open cached errors here: the fresh status decides. A still
        // invalid group re-opens in applySource after a successful poll; a
        // fixed one only reports recovery.
        void poll()
      }) ?? (() => {})
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      stopGeneration()
    }
  }, [add, close, connection, groups, groupsBySource, openError, sources, update])

  return null
}

/**
 * Config-status notices for one plugin, mounted through `shell.overlay`.
 *
 * The viewport is rendered inline in the slot subtree (never portaled to
 * `document.body`), so it inherits the host theme and unloads with the plugin.
 * All plugins share one viewport through {@link noticeHub}; notices from both
 * config files stack instead of overlapping.
 */
export function ConfigStatusToast({
  statusUrl,
  pollMs = DEFAULT_POLL_MS,
  connection,
}: ConfigStatusToastProps) {
  const id = React.useState(() => Symbol('config-notice'))[0]
  const groups = React.useRef(new Map<string, GroupState>())
  const groupsBySource = React.useRef(new Map<string, Set<string>>())

  React.useEffect(() => {
    const hub = noticeHub()
    hub.sources.set(id, { url: statusUrl, pollMs })
    notifyHub(hub)
    return () => {
      hub.sources.delete(id)
      notifyHub(hub)
    }
  }, [id, pollMs, statusUrl])

  // Re-render when a source registers or unregisters; the snapshot itself is
  // only the version counter, while `hub.sources` is the live registry.
  React.useSyncExternalStore(subscribeHub, hubVersion, () => 0)
  const hub = noticeHub()
  const sources = [...hub.sources.values()]
  const leader = hub.sources.keys().next().value

  const onDismiss = (key: string): void => {
    const group = groups.current.get(key)
    if (group === undefined) return
    group.dismissed = true
    group.toastId = undefined
  }

  // Every registration returns one Root; only the leader fills it, so a second
  // plugin never adds a competing fixed viewport.
  return (
    <Root className="dshx:pointer-events-none">
      {leader === id ? (
        <Toast.Provider limit={5} timeout={RECOVERY_TIMEOUT_MS}>
          <StatusWatcher
            sources={sources}
            connection={connection}
            tracking={{ groups, groupsBySource }}
          />
          <Toast.Viewport
            data-config-toast-viewport=""
            className="dshx:fixed dshx:inset-x-0 dshx:bottom-0 dshx:z-50 dshx:mx-auto dshx:flex dshx:max-w-[440px] dshx:flex-col dshx:gap-2 dshx:p-4 dshx:pointer-coarse:p-3"
          >
            <ToastList onDismiss={onDismiss} />
          </Toast.Viewport>
        </Toast.Provider>
      ) : null}
    </Root>
  )
}
