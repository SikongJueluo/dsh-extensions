import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { Alert, Root, cn, type DshClientContext } from '@dsh-extensions/ui'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  MenuSurface,
  useDismissOnOutsidePointer,
  PermissionIconWorkspaceWriteRegular,
} from '@dsh-extensions/ui/host'
import { directoryOptions, type WorkspaceOption } from './checklist'
import './styles.css'

const NS = 'session-write-access'
const RPC = '/dsh-session-write-access'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type Translate = (key: string, params?: Record<string, unknown>) => string

const en: Record<string, string> = {
  panel: 'Write scope',
  title: 'Writable workspaces',
  current: 'Current workspace',
  fixed: 'Always writable',
  writable: 'Writable',
  coveredBy: 'Writable via {path}',
  pendingTitle: 'Allow directory write access?',
  allow: 'Allow directory',
  loading: 'Loading…',
  retry: 'Retry',
  busy: 'Another permission change is in progress.',
}

const zh: Record<string, string> = {
  panel: '写入范围',
  title: '可写工作区',
  current: '当前工作区',
  fixed: '固定授权',
  writable: '已授权写入',
  coveredBy: '经 {path} 可写',
  pendingTitle: '允许写入此目录？',
  allow: '允许写入',
  loading: '加载中…',
  retry: '重试',
  busy: '另一项权限变更正在进行。',
}

interface PendingRequest {
  requestId: string
  path: string
  reason?: string
}

interface WriteAccessView {
  defaultMode: SandboxMode
  workspaceRoot: string
  revision: number
  deploymentRoots: string[]
  grants: { path: string }[]
  pending: PendingRequest[]
}

interface SharedState {
  open: boolean
  keyboardOpen: boolean
  sessionId: string | null
  mode: SandboxMode | null
  view: WriteAccessView | null
  busy: boolean
  operation: 'state' | 'mutation' | null
  error: string | null
  listeners: (() => void)[]
}

const S: SharedState = {
  open: false,
  keyboardOpen: false,
  sessionId: null,
  mode: null,
  view: null,
  busy: false,
  operation: null,
  error: null,
  listeners: [],
}

function setState(patch: Partial<SharedState>) {
  Object.assign(S, patch)
  S.listeners.slice().forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  S.listeners.push(listener)
  return () => {
    const index = S.listeners.indexOf(listener)
    if (index >= 0) S.listeners.splice(index, 1)
  }
}

function close() {
  setState({ open: false })
}

function useShared(): SharedState {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((value) => value + 1)), [])
  return S
}

type RpcEnvelope =
  | { ok: true; value: WriteAccessView; error?: undefined }
  | { ok: false; value?: undefined; error?: { message?: string } }

function rpc(method: string, args: Record<string, unknown>): Promise<WriteAccessView> {
  return fetch(RPC, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...args }),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
    .then((envelope: RpcEnvelope | undefined) => {
      if (!envelope || !envelope.ok) {
        throw new Error(envelope && envelope.error ? envelope.error.message : 'invalid response')
      }
      return envelope.value
    })
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

let requestVersion = 0
let refreshQueued = false

function mutate(method: string, extra: Record<string, unknown>, preserveError = false) {
  const sessionId = S.sessionId
  const version = ++requestVersion
  setState({
    busy: true,
    operation: method === 'state' ? 'state' : 'mutation',
    error: preserveError ? S.error : null,
  })
  return rpc(method, { sessionId, ...extra })
    .then((view) => {
      if (S.sessionId === sessionId && requestVersion === version) setState({ view })
      return undefined
    })
    .catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(messageOf(error))
      if (S.sessionId === sessionId && requestVersion === version)
        setState({ error: failure.message })
      return failure
    })
    .finally(() => {
      if (S.sessionId !== sessionId || requestVersion !== version) return
      setState({ busy: false, operation: null })
      if (refreshQueued) {
        refreshQueued = false
        void refresh(true)
      }
    })
}

function refresh(preserveError = false) {
  if (!S.sessionId) return Promise.resolve()
  if (S.busy) {
    refreshQueued = true
    return Promise.resolve()
  }
  return mutate('state', {}, preserveError)
}

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionSources {
  binding(sessionId: string):
    | {
        session: { projections: { faceOf(key: string): SnapshotSource<unknown> } }
        eventSource: SnapshotSource<SessionEventWindow>
      }
    | undefined
}

declare module '@dsh-extensions/ui' {
  interface DshClientServices {
    readonly workspaces?: {
      readonly list: SnapshotSource<{ readonly items: readonly WorkspaceOption[] }>
    }
    readonly sessions?: SessionSources
  }
}

interface WorkspaceMenuProps {
  sessionId: string
  sessions: SessionSources
  t: Translate
}

const controlClass = cn(
  'dshx:inline-flex dshx:h-7 dshx:items-center dshx:gap-1 dshx:whitespace-nowrap',
  'dshx:rounded-[var(--dsw-radius-sm)] dshx:border-0 dshx:bg-transparent dshx:px-2',
  'dshx:text-[13px] dshx:font-medium dshx:leading-5 dshx:text-fg-secondary',
  'dshx:hover:bg-surface-hover dshx:aria-expanded:bg-surface-hover dshx:pointer-coarse:min-h-11',
)

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function WorkspaceMenu({ sessionId, sessions, t }: WorkspaceMenuProps) {
  const shared = useShared()
  const binding = sessions.binding(sessionId)
  const source = binding?.session.projections.faceOf('sandboxMode')
  const mode = useSyncExternalStore(
    (listener) => source?.subscribe(listener) ?? (() => {}),
    () => source?.getSnapshot(),
    () => undefined,
  )
  useEffect(() => {
    refreshQueued = false
    const currentMode = sessions
      .binding(sessionId)
      ?.session.projections.faceOf('sandboxMode')
      .getSnapshot()
    setState({
      sessionId,
      view: null,
      mode: isSandboxMode(currentMode) ? currentMode : null,
      busy: false,
      operation: null,
      error: null,
      open: false,
    })
    void refresh()
    return () => {
      if (S.sessionId === sessionId) {
        requestVersion += 1
        refreshQueued = false
        close()
        setState({ sessionId: null, view: null, mode: null, busy: false, operation: null })
      }
    }
  }, [sessionId, sessions])
  useEffect(() => {
    setState({
      mode: isSandboxMode(mode) ? mode : null,
    })
    if (mode !== undefined && mode !== null && mode !== 'workspace-write') close()
  }, [mode])
  useEffect(() => {
    const events = binding?.eventSource
    return events?.subscribe(() => {
      const change = events.getSnapshot().change
      if (
        change.kind === 'replace' ||
        (change.kind === 'append' &&
          change.entries.some(
            (entry) => entry.type === 'event' && entry.event.type === 'tool/result',
          ))
      )
        void refresh()
    })
  }, [binding])

  if (shared.sessionId !== sessionId) return null
  const view = shared.view
  if ((mode ?? view?.defaultMode) !== 'workspace-write') return null
  return (
    <Root className="dshx:inline-flex">
      <button
        ref={(node) => {
          anchorRef.current = node
        }}
        type="button"
        className={cn(controlClass, 'dsh-swa-anchor')}
        aria-label={t('panel')}
        aria-haspopup="menu"
        aria-controls={shared.open ? 'session-write-access-menu' : undefined}
        aria-expanded={shared.open}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setState({ open: true, keyboardOpen: true })
            void refresh()
          }
          if (event.key === 'Escape') close()
        }}
        onClick={() => {
          if (shared.open) close()
          else {
            setState({ open: true, keyboardOpen: false })
            void refresh()
          }
        }}
      >
        <PermissionIconWorkspaceWriteRegular size={14} />
        <span>{t('panel')}</span>
        <IconChevronDownOutlineRegular
          size={12}
          className={cn(
            'dshx:text-fg-tertiary dshx:transition-transform',
            shared.open && 'dshx:rotate-180',
          )}
        />
      </button>
    </Root>
  )
}

const anchorRef: { current: HTMLButtonElement | null } = { current: null }

function WorkspaceList({
  t,
  workspaces: workspaceSource,
}: {
  t: Translate
  workspaces: SnapshotSource<{ readonly items: readonly WorkspaceOption[] }>
}) {
  const shared = useShared()
  const panelRef = useRef<HTMLDivElement>(null)
  const workspaces = useSyncExternalStore(
    (listener) => workspaceSource.subscribe(listener),
    () => workspaceSource.getSnapshot(),
    () => workspaceSource.getSnapshot(),
  )
  const open = shared.open && (shared.mode ?? shared.view?.defaultMode) === 'workspace-write'
  useDismissOnOutsidePointer(anchorRef, open, close, panelRef)
  useEffect(() => {
    if (open && shared.keyboardOpen)
      panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, shared.keyboardOpen])
  if (!open) return null
  const view = shared.view
  const options = view
    ? directoryOptions(view.workspaceRoot, view.deploymentRoots, view.grants, workspaces.items)
    : []
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
      close()
      anchorRef.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    )
    const index = buttons.findIndex(
      (button) => button === event.currentTarget.ownerDocument.activeElement,
    )
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return (
    <Root>
      <MenuSurface
        ref={panelRef}
        id="session-write-access-menu"
        role="menu"
        aria-label={t('title')}
        aria-busy={shared.busy}
        className="dsh-swa-menu"
        onKeyDown={keydown}
      >
        <div className="dsh-swa-heading">{t('title')}</div>
        <div className="dsh-swa-viewport" role="presentation">
          {options.map((option) => (
            <button
              key={option.path}
              type="button"
              role="menuitemcheckbox"
              aria-checked={option.checked}
              disabled={shared.busy || option.fixed || (option.checked && !option.grant)}
              className="dsh-swa-option"
              onClick={() => {
                void mutate(option.grant ? 'remove' : 'add', { path: option.path })
              }}
            >
              <span className="dsh-swa-option-copy">
                <span className="dsh-swa-option-title">
                  <span>{option.title ?? option.path}</span>
                  {option.fixed ? (
                    <span className="dsh-swa-note">
                      {t(option.path === view?.workspaceRoot ? 'current' : 'fixed')}
                    </span>
                  ) : null}
                </span>
                {option.title ? <span className="dsh-swa-note">{option.path}</span> : null}
                {option.coveredBy ? (
                  <span className="dsh-swa-note">{t('coveredBy', { path: option.coveredBy })}</span>
                ) : null}
              </span>
              {option.checked ? <IconCheckOutlineRegular size={16} /> : null}
            </button>
          ))}
        </div>
        {shared.busy && !view ? <output className="dsh-swa-heading">{t('loading')}</output> : null}
        {shared.error ? (
          <div className="dsh-swa-error">
            <Alert variant="error">{shared.error}</Alert>
            <button
              type="button"
              role="menuitem"
              className="dsh-swa-option"
              disabled={shared.busy}
              onClick={() => {
                void refresh()
              }}
            >
              {t('retry')}
            </button>
          </div>
        ) : null}
      </MenuSurface>
    </Root>
  )
}

interface ApprovalCardInput {
  requestKey: string
  title: string
  description?: string
  subject: { name: string }
  allowLabel: string
  canAnswer: () => boolean
  onAllow: () => Promise<void>
  onReject: () => Promise<void>
}

function PendingApprovals({
  sessionId,
  t,
  renderFactorySlot,
}: {
  sessionId: string
  t: Translate
  renderFactorySlot: (name: 'conversation.approval.card', input: ApprovalCardInput) => ReactNode
}) {
  const shared = useShared()
  const view = shared.view
  if (
    shared.sessionId !== sessionId ||
    (shared.mode ?? view?.defaultMode) !== 'workspace-write' ||
    !view ||
    view.pending.length === 0
  )
    return null
  return (
    <>
      {view.pending.map((request) => {
        const requestId = request.requestId
        const expectedRevision = view.revision
        function canAnswer() {
          const currentView = S.view
          if (!currentView) return false
          return (
            S.sessionId === sessionId &&
            (S.mode ?? currentView.defaultMode) === 'workspace-write' &&
            currentView.revision === expectedRevision &&
            currentView.pending.some((pending) => pending.requestId === requestId)
          )
        }
        async function answer(decision: 'allow' | 'deny') {
          if (!canAnswer()) return
          if (S.operation === 'mutation') {
            const error = new Error(t('busy'))
            setState({ error: error.message })
            throw error
          }
          const failure = await mutate('decide', {
            requestId,
            decision,
            expectedRevision,
          })
          if (failure) throw failure
        }
        return renderFactorySlot('conversation.approval.card', {
          requestKey: `${sessionId}:${requestId}:${expectedRevision}`,
          title: t('pendingTitle'),
          description: request.reason,
          subject: { name: request.path },
          allowLabel: t('allow'),
          canAnswer,
          onAllow: () => answer('allow'),
          onReject: () => answer('deny'),
        })
      })}
      {shared.error ? (
        <Root>
          <Alert variant="error">{shared.error}</Alert>
        </Root>
      ) : null}
    </>
  )
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-write-access: locale')
  const t = ctx.locale.bind(NS)
  const workspaces = ctx.get('workspaces')
  const sessions = ctx.get('sessions')
  if (!workspaces || !sessions)
    throw new Error('Session write access requires workspaces and sessions')

  ctx.slots.inject('conversation.input.left', () => {
    return ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-session-write-access',
        order: 40,
        label: () => t('panel'),
        inject: () => ({ t, sessions }),
      },
      WorkspaceMenu,
    )
  })
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-session-write-access',
        order: 60,
        inject: () => ({ t, workspaces: workspaces.list }),
      },
      WorkspaceList,
    ),
  )
  ctx.slots.inject('conversation.input.dock', () => {
    return ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-session-write-access',
        order: 40,
        inject: () => ({ t }),
      },
      PendingApprovals,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale', 'workspaces', 'sessions']
