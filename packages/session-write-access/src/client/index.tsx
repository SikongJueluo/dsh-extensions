/* oxlint-disable react/set-state-in-effect -- the effect mirrors external data into local UI state; deriving it would change render timing */
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Root,
  Spinner,
  type DshClientContext,
  type WorkspaceClientLike,
} from '@dsh-extensions/ui'
import { directoryOptions, type WorkspaceOption } from './checklist'
import './styles.css'

const NS = 'session-write-access'
const RPC = '/dsh-session-write-access'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

const en: Record<string, string> = {
  panel: 'Write scope',
  title: 'Writable workspaces',
  close: 'Close',
  current: 'Current workspace',
  fixed: 'Always writable',
  coveredBy: 'Writable via {path}',
  pendingTitle: 'Pending requests',
  allow: 'Allow',
  deny: 'Deny',
  addTitle: 'Other directory',
  addPlaceholder: 'Absolute directory path',
  add: 'Add',
  pick: 'Choose directory',
  more: 'More',
  fork: 'Fork and inherit grants',
  forkNote: 'The stock Fork button does not inherit extra directories.',
  oldProcessNote: 'Changes apply to new calls. Running processes keep their starting permissions.',
  loading: 'Loading…',
  refresh: 'Refresh',
  forkCreated: 'Forked session {id} is now open.',
  forkFailed: 'Fork failed: {message}',
  forkPreviousFailed: "The previous Fork did not finish. Check that session's write scope.",
  forkSeq: 'Event seq (optional)',
  recent: 'Recent decisions',
  alreadyCovered: 'Already writable via {path}.',
}

const zh: Record<string, string> = {
  panel: '写入范围',
  title: '可写工作区',
  close: '关闭',
  current: '当前工作区',
  fixed: '固定授权',
  coveredBy: '经 {path} 可写',
  pendingTitle: '待确认申请',
  allow: '允许',
  deny: '拒绝',
  addTitle: '其他目录',
  addPlaceholder: '目录的绝对路径',
  add: '添加',
  pick: '选择目录',
  more: '更多',
  fork: 'Fork 并继承授权',
  forkNote: '原生 Fork 按钮不会继承额外目录。',
  oldProcessNote: '变更对后续调用生效，已运行的进程保留启动时的权限。',
  loading: '加载中…',
  refresh: '刷新',
  forkCreated: '已创建并打开会话 {id}。',
  forkFailed: 'Fork 失败：{message}',
  forkPreviousFailed: '上次 Fork 未完成，请检查该会话的写入范围。',
  forkSeq: '事件序号（可选）',
  recent: '最近决定',
  alreadyCovered: '已通过 {path} 获得写入权限。',
}

interface Grant {
  path: string
}

interface PendingRequest {
  requestId: string
  path: string
  reason?: string
}

interface RecentDecision {
  requestId: string
  path: string
  status?: string
}

interface ForkRecord {
  stage?: string
}

interface WriteAccessView {
  effectiveMode: SandboxMode
  defaultMode: SandboxMode
  workspaceRoot: string
  revision: number
  coveredBy?: string
  stillCoveredBy?: string
  deploymentRoots: string[]
  grants: Grant[]
  pending: PendingRequest[]
  recent: RecentDecision[]
  forks: ForkRecord[]
}

interface SharedState {
  open: boolean
  sessionId: string | null
  mode: SandboxMode | null
  view: WriteAccessView | null
  busy: boolean
  error: string | null
  notice: string | null
  listeners: (() => void)[]
}

const S: SharedState = {
  open: false,
  sessionId: null,
  mode: null,
  view: null,
  busy: false,
  error: null,
  notice: null,
  listeners: [],
}

function setState(patch: Partial<SharedState>) {
  Object.assign(S, patch)
  S.listeners.slice().forEach((listener) => {
    listener()
  })
}

function subscribe(listener: () => void) {
  S.listeners.push(listener)
  return () => {
    const index = S.listeners.indexOf(listener)
    if (index >= 0) S.listeners.splice(index, 1)
  }
}

function close() {
  setState({ open: false, error: null, notice: null })
}

function useShared(): SharedState {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((value) => value + 1)), [])
  return S
}

type RpcEnvelope<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; value?: undefined; error?: { message?: string } }

function rpc<T = WriteAccessView>(method: string, args: Record<string, unknown>): Promise<T> {
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
    .then((envelope: RpcEnvelope<T> | undefined) => {
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

function refresh() {
  const sessionId = S.sessionId
  if (!sessionId) return Promise.resolve()
  const version = ++requestVersion
  setState({ busy: true, error: null })
  return rpc('state', { sessionId })
    .then((view) => {
      if (S.sessionId === sessionId && requestVersion === version) setState({ view, busy: false })
      return undefined
    })
    .catch((error: unknown) => {
      if (S.sessionId === sessionId && requestVersion === version)
        setState({ busy: false, error: messageOf(error) })
    })
}

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionSources {
  binding(
    sessionId: string,
  ): { session: { projections: { faceOf(key: string): SnapshotSource<unknown> } } } | undefined
}

declare module '@dsh-extensions/ui' {
  interface DshClientServices {
    readonly workspaces?: {
      readonly list: SnapshotSource<{ readonly items: readonly WorkspaceOption[] }>
    }
    readonly sessions?: SessionSources
  }
}

interface PanelButtonProps {
  sessionId: string
  sessions: SessionSources
  t: Translate
}

type Translate = (key: string, params?: Record<string, unknown>) => string

interface OverlayProps {
  t: Translate
  mutate: (method: string, extra: Record<string, unknown>) => Promise<unknown>
  fork: (atSeq?: number) => Promise<void>
  workspaceClient: WorkspaceClientLike | undefined
  workspaces: SnapshotSource<{ readonly items: readonly WorkspaceOption[] }>
}

function PanelButton(props: PanelButtonProps) {
  const { sessionId, t } = props
  const shared = useShared()
  const source = props.sessions.binding(sessionId)?.session.projections.faceOf('sandboxMode')
  const mode = useSyncExternalStore(
    (listener) => source?.subscribe(listener) ?? (() => {}),
    () => source?.getSnapshot(),
    () => undefined,
  )
  useEffect(() => {
    setState({ sessionId, view: null, busy: false, error: null, notice: null, open: false })
    void refresh()
    return () => {
      if (S.sessionId === sessionId) {
        requestVersion += 1
        close()
        setState({ sessionId: null, view: null, mode: null })
      }
    }
  }, [sessionId])
  useEffect(() => {
    setState({
      mode:
        mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
          ? mode
          : null,
    })
    if (mode !== undefined && mode !== null && mode !== 'workspace-write') close()
  }, [mode])

  if (shared.sessionId !== sessionId) return null
  const effectiveMode = mode ?? shared.view?.defaultMode
  if (effectiveMode !== 'workspace-write') return null
  const pending = shared.view?.pending.length ?? 0
  return (
    <Root className="dshx:inline-flex">
      <Button
        variant="ghost"
        size="md"
        title={t('panel')}
        aria-label={t('panel')}
        disabled={shared.busy}
        onClick={() => {
          setState({ open: true, error: null, notice: null })
          void refresh()
        }}
      >
        <span>{t('panel')}</span>
        {pending > 0 ? <Badge variant="brand">{String(pending)}</Badge> : null}
      </Button>
    </Root>
  )
}

function Overlay(props: OverlayProps) {
  const { t, mutate, fork, workspaceClient } = props
  const shared = useShared()
  const workspaces = useSyncExternalStore(
    (listener) => props.workspaces.subscribe(listener),
    () => props.workspaces.getSnapshot(),
    () => props.workspaces.getSnapshot(),
  )
  const [path, setPath] = useState('')
  const [forkSeq, setForkSeq] = useState('')
  useEffect(() => {
    if (!shared.open) {
      setPath('')
      setForkSeq('')
    }
  }, [shared.open])

  function choose() {
    if (!workspaceClient?.pickDirectory) return
    const sessionId = S.sessionId
    const version = requestVersion
    Promise.resolve(workspaceClient.pickDirectory())
      .then((picked) => {
        if (
          S.sessionId !== sessionId ||
          requestVersion !== version ||
          !S.open ||
          (S.mode ?? S.view?.defaultMode) !== 'workspace-write'
        )
          return undefined
        if (typeof picked === 'string' && picked.length > 0) {
          setPath(picked)
          return mutate('add', { path: picked })
        }
        return undefined
      })
      .catch((error: unknown) => {
        if (S.sessionId === sessionId) setState({ error: messageOf(error) })
      })
  }

  const view = shared.view
  const busy = shared.busy
  const visible = (shared.mode ?? view?.defaultMode) === 'workspace-write'
  const options = view
    ? directoryOptions(view.workspaceRoot, view.deploymentRoots, view.grants, workspaces.items)
    : []

  return (
    <Root>
      <Dialog
        open={shared.open && visible}
        onOpenChange={(open) => {
          if (open) setState({ open: true })
          else close()
        }}
        title={t('title')}
        closeLabel={t('close')}
        className="dshx:w-[min(480px,94vw)]"
      >
        {!view && busy ? (
          <output className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-xs dshx:text-fg-muted">
            <Spinner />
            {t('loading')}
          </output>
        ) : null}

        {view ? (
          <fieldset
            disabled={busy}
            aria-label={t('title')}
            className="dshx:m-0 dshx:min-w-0 dshx:border-0 dshx:p-0"
          >
            {options.map((option) => {
              const locked = option.fixed || (option.checked && !option.grant)
              return (
                <label
                  key={option.path}
                  className="dshx:flex dshx:min-h-11 dshx:cursor-pointer dshx:items-center dshx:gap-3 dshx:rounded-control dshx:px-2 dshx:py-2.5 dshx:hover:bg-surface-2 dshx:has-disabled:cursor-default"
                >
                  <input
                    type="checkbox"
                    checked={option.checked}
                    disabled={locked}
                    className="dshx:size-4 dshx:shrink-0 dshx:accent-brand dshx:focus-visible:outline-2 dshx:focus-visible:outline-offset-2 dshx:focus-visible:outline-brand"
                    onChange={() => {
                      void mutate(option.grant ? 'remove' : 'add', { path: option.path })
                    }}
                  />
                  <span className="dshx:min-w-0 dshx:flex-1">
                    <span className="dshx:block dshx:break-all dshx:text-sm">
                      {option.title ?? option.path}
                    </span>
                    {option.title ? (
                      <span className="dshx:block dshx:break-all dshx:text-2xs dshx:text-fg-muted">
                        {option.path}
                      </span>
                    ) : null}
                    {option.coveredBy ? (
                      <span className="dshx:block dshx:break-all dshx:text-2xs dshx:text-fg-muted">
                        {t('coveredBy', { path: option.coveredBy })}
                      </span>
                    ) : null}
                  </span>
                  {option.path === view.workspaceRoot || option.fixed ? (
                    <span className="dshx:shrink-0 dshx:text-2xs dshx:text-fg-muted">
                      {t(option.path === view.workspaceRoot ? 'current' : 'fixed')}
                    </span>
                  ) : null}
                </label>
              )
            })}
          </fieldset>
        ) : null}

        {view && view.pending.length > 0 ? (
          <Field
            label={t('pendingTitle')}
            className="dshx:mt-4 dshx:border-t dshx:border-border dshx:pt-4"
          >
            {view.pending.map((request) => (
              <div
                key={request.requestId}
                className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2 dshx:py-2"
              >
                <div className="dshx:min-w-0 dshx:basis-48 dshx:grow dshx:break-all dshx:text-xs">
                  {request.path}
                  {request.reason ? (
                    <div className="dshx:mt-1 dshx:text-fg-muted">{request.reason}</div>
                  ) : null}
                </div>
                {(['allow', 'deny'] as const).map((decision) => (
                  <Button
                    key={decision}
                    size="md"
                    variant={decision === 'allow' ? 'default' : 'ghost'}
                    disabled={busy}
                    onClick={() => {
                      void mutate('decide', {
                        requestId: request.requestId,
                        decision,
                        expectedRevision: view.revision,
                      })
                    }}
                  >
                    {t(decision)}
                  </Button>
                ))}
              </div>
            ))}
          </Field>
        ) : null}

        {view ? (
          <details className="dshx:mt-3 dshx:border-t dshx:border-border dshx:pt-1">
            <summary className="dshx:flex dshx:min-h-11 dshx:cursor-pointer dshx:items-center dshx:text-xs dshx:text-fg-muted">
              {t('more')}
            </summary>
            <Field label={t('addTitle')}>
              <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
                <Input
                  value={path}
                  aria-label={t('addTitle')}
                  placeholder={t('addPlaceholder')}
                  disabled={busy}
                  className="dshx:min-w-0 dshx:flex-1"
                  onChange={(event) => setPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy && path.trim())
                      void mutate('add', { path: path.trim() })
                  }}
                />
                <Button
                  size="md"
                  disabled={busy || !path.trim()}
                  onClick={() => {
                    void mutate('add', { path: path.trim() })
                  }}
                >
                  {t('add')}
                </Button>
                {workspaceClient?.pickDirectory ? (
                  <Button size="md" variant="secondary" disabled={busy} onClick={choose}>
                    {t('pick')}
                  </Button>
                ) : null}
              </div>
            </Field>
            <Field label={t('fork')} hint={t('forkNote')} className="dshx:mt-4">
              <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
                <Input
                  value={forkSeq}
                  aria-label={t('forkSeq')}
                  placeholder={t('forkSeq')}
                  inputMode="numeric"
                  disabled={busy}
                  className="dshx:min-w-0 dshx:flex-1"
                  onChange={(event) => setForkSeq(event.target.value)}
                />
                <Button
                  size="md"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const parsed = forkSeq.trim() === '' ? undefined : Number(forkSeq.trim())
                    if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0)) {
                      setState({ error: `${t('forkSeq')}: ${forkSeq}` })
                      return
                    }
                    void fork(parsed)
                  }}
                >
                  {t('fork')}
                </Button>
              </div>
              {view.forks.some((record) => record.stage === 'failed') ? (
                <Alert variant="error" className="dshx:mt-2">
                  {t('forkPreviousFailed')}
                </Alert>
              ) : null}
            </Field>
            {view.recent.length > 0 ? (
              <details className="dshx:mt-4 dshx:text-xs">
                <summary className="dshx:min-h-11 dshx:cursor-pointer dshx:py-3 dshx:text-fg-muted">
                  {t('recent')}
                </summary>
                {view.recent.map((request) => (
                  <div
                    key={request.requestId}
                    className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-2 dshx:py-2"
                  >
                    <span className="dshx:break-all">{request.path}</span>
                    <Badge variant="outline">{request.status}</Badge>
                  </div>
                ))}
              </details>
            ) : null}
            <p className="dshx:mt-4 dshx:text-2xs dshx:text-fg-muted">{t('oldProcessNote')}</p>
            <Button
              size="md"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void refresh()
              }}
            >
              {t('refresh')}
            </Button>
          </details>
        ) : null}

        {shared.notice ? (
          <Alert variant="info" className="dshx:mt-3">
            {shared.notice}
          </Alert>
        ) : null}
        {shared.error ? (
          <Alert variant="error" className="dshx:mt-3 dshx:whitespace-pre-wrap">
            {shared.error}
          </Alert>
        ) : null}
      </Dialog>
    </Root>
  )
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-write-access: locale')
  const t = ctx.locale.bind(NS)
  const workspaceClient = ctx.get('uiWorkspace')
  const workspaces = ctx.get('workspaces')
  const sessions = ctx.get('sessions')
  if (!workspaces || !sessions)
    throw new Error('Session write access requires workspaces and sessions')

  function mutate(method: string, extra: Record<string, unknown>) {
    const sessionId = S.sessionId
    const version = ++requestVersion
    setState({ busy: true, error: null, notice: null })
    return rpc(method, { sessionId, ...extra })
      .then((view) => {
        if (S.sessionId === sessionId && requestVersion === version) {
          const coveredBy = view.coveredBy ?? view.stillCoveredBy
          setState({
            view,
            busy: false,
            notice: coveredBy ? t('alreadyCovered', { path: coveredBy }) : null,
          })
        }
        return view
      })
      .catch((error: unknown) => {
        if (S.sessionId === sessionId && requestVersion === version)
          setState({ busy: false, error: messageOf(error) })
      })
  }

  function fork(atSeq?: number) {
    const sessionId = S.sessionId
    const version = ++requestVersion
    setState({ busy: true, error: null, notice: null })
    return rpc<{ sessionId: string }>('fork', { sessionId, atSeq })
      .then((created) => {
        if (S.sessionId !== sessionId || requestVersion !== version) return undefined
        setState({ busy: false, notice: t('forkCreated', { id: created.sessionId }) })
        workspaceClient?.openSession?.(created.sessionId)
        return undefined
      })
      .catch((error: unknown) => {
        if (S.sessionId === sessionId && requestVersion === version) {
          setState({ busy: false, error: t('forkFailed', { message: messageOf(error) }) })
        }
      })
  }

  ctx.slots.inject('conversation.input.left', () => {
    return ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-session-write-access',
        order: 40,
        label: () => t('panel'),
        inject: () => ({ t, sessions }),
      },
      PanelButton,
    )
  })
  ctx.slots.inject('shell.overlay', () => {
    return ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-session-write-access',
        order: 60,
        inject: () => ({ t, mutate, fork, workspaceClient, workspaces: workspaces.list }),
      },
      Overlay,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions']
