// Client half of dsh-session-write-access.
//
// Two additive slots:
//   - `conversation.input.left`: a compact write-scope button beside the stock
//     composer controls (never replacing the permission control);
//   - `shell.overlay`: the panel itself, in the frame-wide floating layer, so
//     it is not clipped by the docked composer.
//
// The panel is the user-only management surface: add a directory, allow/deny
// a persistent Agent request, revoke a grant, or fork this session with its
// current grants. All decisions are posted to this package's same-origin
// route; the host re-validates every path and never accepts a browser-supplied
// actor.
//
// TypeScript TSX on the shared @dsh-extensions/ui components; the panel is the
// shared `Dialog` controlled by the module-level state below.
import { useEffect, useState } from 'react'
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
} from '@dsh-extensions/ui'
import './styles.css'

const NS = 'session-write-access'
const RPC = '/dsh-session-write-access'

const en: Record<string, string> = {
  panel: 'Write scope',
  panelCompact: '{dirs} dirs',
  panelPending: '{n} pending',
  title: 'Write scope',
  close: 'Close',
  mode: 'Mode',
  workspace: 'Workspace',
  deploymentRoots: 'Deployment directories',
  deploymentNote: 'Granted by the deployment; not revocable here.',
  grants: 'Extra writable directories',
  noGrants: 'No extra directory yet. The workspace above is writable.',
  sourceUser: 'user',
  sourceFork: 'forked',
  coveredBy: 'still writable via {path}',
  revoke: 'Revoke',
  confirmRevoke: 'Confirm revoke',
  pendingTitle: 'Pending requests',
  noPending: 'No pending request.',
  allow: 'Allow',
  deny: 'Deny',
  requestedBy: 'requested by {session}',
  addTitle: 'Add a directory',
  addPlaceholder: 'Absolute path of an existing directory',
  add: 'Add',
  pick: 'Choose directory',
  forkTitle: 'Fork with grants',
  fork: 'Fork and inherit grants',
  forkNote:
    'Copies the directories granted at click time into an independent group. The stock Fork button does NOT inherit these directories; it keeps only the workspace and deployment roots.',
  oldProcessNote:
    'New grants apply to new calls. Shells and background processes already running keep the permissions they started with; revoking does not terminate them.',
  error: 'Failed: {message}',
  loading: 'Loading…',
  refresh: 'Refresh',
  forkCreated: 'Forked session {id} is now open.',
  forkFailed: 'Fork failed: {message}',
  forkPreviousFailed:
    "The previous Fork did not finish. Check that session's write scope before relying on inherited directories.",
  forkSeq: 'Event seq (optional)',
  notAttributed:
    'This session has no write-access group yet. Send a message or reopen the session, then retry.',
  recent: 'Recent decisions',
  reason: 'Reason',
  session: 'session',
  allowNote:
    'Allows this session and its local subagents to create, modify, and delete files under this directory and its subdirectories until revoked.',
  empty: '—',
  alreadyCovered: 'Already writable via {path}.',
}

const zh: Record<string, string> = {
  panel: '写入范围',
  panelCompact: '{dirs} 个目录',
  panelPending: '{n} 项待确认',
  title: '写入范围',
  close: '关闭',
  mode: '模式',
  workspace: '工作区',
  deploymentRoots: '部署级目录',
  deploymentNote: '由部署配置授予，此处不可撤销。',
  grants: '额外可写目录',
  noGrants: '还没有额外目录。上方工作区可写。',
  sourceUser: '用户授权',
  sourceFork: 'Fork 继承',
  coveredBy: '仍可经 {path} 写入',
  revoke: '撤销',
  confirmRevoke: '确认撤销',
  pendingTitle: '待确认申请',
  noPending: '没有待确认申请。',
  allow: '允许',
  deny: '拒绝',
  requestedBy: '由 {session} 申请',
  addTitle: '添加目录',
  addPlaceholder: '已存在目录的绝对路径',
  add: '添加',
  pick: '选择目录',
  forkTitle: 'Fork 并继承授权',
  fork: 'Fork 并继承授权',
  forkNote:
    '把点击时有效的额外目录复制到一个独立授权组。原生 Fork 按钮不会继承这些目录，只保留工作区与部署级目录。',
  oldProcessNote:
    '新授权对后续调用生效。已经运行的终端和后台进程保留启动时的权限；撤销不会终止它们。',
  error: '操作失败：{message}',
  loading: '加载中…',
  refresh: '刷新',
  forkCreated: '已创建并打开会话 {id}。',
  forkFailed: 'Fork 失败：{message}',
  forkPreviousFailed: '上次 Fork 未完成。请在依赖继承目录前检查该会话的写入范围。',
  forkSeq: '事件序号（可选）',
  notAttributed: '此会话还没有写入授权组。请先发送消息或重新打开会话后重试。',
  recent: '最近决定',
  reason: '理由',
  session: '会话',
  allowNote: '允许此会话及其本地子 Agent 在该目录及子目录内新建、修改、删除文件，直到撤销。',
  empty: '—',
  alreadyCovered: 'Already writable via {path}.',
}

interface Grant {
  path: string
  source?: string
  coveredBy?: string
}

interface PendingRequest {
  requestId: string
  path: string
  reason?: string
  sessionId?: string | number
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
  effectiveMode?: string
  defaultMode?: string
  workspaceRoot?: string
  revision?: number
  coveredBy?: string
  deploymentRoots?: string[]
  grants?: Grant[]
  pending?: PendingRequest[]
  recent?: RecentDecision[]
  forks?: ForkRecord[]
}

interface WorkspaceClient {
  openSession?(sessionId: string): unknown
  pickDirectory?(): Promise<unknown> | unknown
}

interface SharedState {
  open: boolean
  sessionId: string | null
  view: WriteAccessView | null
  busy: boolean
  error: string | null
  notice: string | null
  listeners: Array<() => void>
}

// --- module-level panel state (two slots share it) ---
const S: SharedState = {
  open: false,
  sessionId: null,
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

function useShared(): SharedState {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((value) => value + 1)), [])
  return S
}

interface RpcEnvelope<T> {
  ok?: boolean
  error?: { message?: string }
  value?: T
}

function rpc<T = WriteAccessView>(method: string, args: Record<string, unknown>): Promise<T> {
  return fetch(RPC, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...args }),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<RpcEnvelope<T>>
    })
    .then((envelope) => {
      if (!envelope || envelope.ok !== true) {
        throw new Error(envelope && envelope.error ? envelope.error.message : 'invalid response')
      }
      return envelope.value as T
    })
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-write-access: locale')
  const t = ctx.locale.bind(NS)
  const workspaceClient = ctx.get<WorkspaceClient | undefined>('uiWorkspace')

  function refresh() {
    const sessionId = S.sessionId
    if (!sessionId) return Promise.resolve()
    setState({ busy: true, error: null })
    return rpc<WriteAccessView>('state', { sessionId })
      .then((view) => {
        if (S.sessionId === sessionId) setState({ view, busy: false })
      })
      .catch((error: unknown) => {
        setState({ busy: false, error: messageOf(error) })
      })
  }

  function mutate(method: string, extra: Record<string, unknown>) {
    const sessionId = S.sessionId
    setState({ busy: true, error: null, notice: null })
    return rpc<WriteAccessView>(method, { sessionId, ...extra })
      .then((view) => {
        if (S.sessionId === sessionId) {
          setState({
            view,
            busy: false,
            notice: view && view.coveredBy ? t('alreadyCovered', { path: view.coveredBy }) : null,
          })
        }
        return view
      })
      .catch((error: unknown) => {
        setState({ busy: false, error: messageOf(error) })
        throw error
      })
  }

  function fork(atSeq?: number) {
    const sessionId = S.sessionId
    setState({ busy: true, error: null, notice: null })
    const args: Record<string, unknown> = { sessionId }
    if (typeof atSeq === 'number') args.atSeq = atSeq
    return rpc<{ sessionId: string }>('fork', args)
      .then((created) => {
        setState({ busy: false, notice: t('forkCreated', { id: created.sessionId }) })
        if (workspaceClient && typeof workspaceClient.openSession === 'function') {
          workspaceClient.openSession(created.sessionId)
        }
        return refresh()
      })
      .catch((error: unknown) => {
        setState({ busy: false, error: t('forkFailed', { message: messageOf(error) }) })
      })
  }

  function PanelButton({ sessionId }: { sessionId?: string }) {
    const shared = useShared()
    const dirs = shared.view?.grants?.length ?? 0
    const pending = shared.view?.pending?.length ?? 0
    useEffect(() => {
      if (!sessionId) return undefined
      if (S.open && S.sessionId !== sessionId) {
        setState({ sessionId, view: null })
        refresh()
      } else if (!S.open) {
        // Keep the compact count current without opening the panel.
        setState({ sessionId })
        rpc<WriteAccessView>('state', { sessionId })
          .then((view) => {
            if (!S.open && S.sessionId === sessionId) setState({ view })
          })
          .catch(() => {
            /* unattributed sessions simply show no counts */
          })
      }
      return undefined
    }, [sessionId, shared.open])
    return (
      <Root className="dshx:inline-flex">
        <Button
          variant="secondary"
          size="md"
          title={t('panel')}
          aria-label={t('panel')}
          onClick={() => {
            setState({ open: true, sessionId, view: null, error: null, notice: null })
            refresh()
          }}
        >
          <span>{t('panelCompact', { dirs })}</span>
          {pending > 0 ? <Badge variant="brand">{String(pending)}</Badge> : null}
        </Button>
      </Root>
    )
  }

  function Overlay() {
    const shared = useShared()
    const [path, setPath] = useState('')
    const [confirmPath, setConfirmPath] = useState<string | null>(null)
    const [forkSeq, setForkSeq] = useState('')
    useEffect(() => {
      if (!shared.open) {
        setConfirmPath(null)
        setPath('')
      }
    }, [shared.open])

    function close() {
      setState({ open: false, error: null, notice: null })
    }

    function choose() {
      if (!workspaceClient || typeof workspaceClient.pickDirectory !== 'function') return
      Promise.resolve(workspaceClient.pickDirectory())
        .then((picked) => {
          if (typeof picked === 'string' && picked.length > 0) {
            setPath(picked)
            mutate('add', { path: picked })
          }
        })
        .catch((error: unknown) => {
          setState({ error: messageOf(error) })
        })
    }

    const view = shared.view
    const busy = shared.busy
    const grants = view?.grants ?? []
    const pending = view?.pending ?? []
    const recent = view?.recent ?? []

    return (
      <Root>
        <Dialog
          open={shared.open}
          onOpenChange={(open) => {
            if (open) setState({ open: true })
            else close()
          }}
          title={t('title')}
          closeLabel={t('close')}
        >
          {!view && busy ? (
            <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-xs dshx:text-fg-muted">
              <Spinner />
              {t('loading')}
            </div>
          ) : null}

          {view ? (
            <div className="dshx:mb-3.5 dshx:grid dshx:grid-cols-[auto_1fr] dshx:gap-x-3 dshx:gap-y-1.5 dshx:text-xs dshx:leading-[18px]">
              <span className="dshx:text-fg-muted">{t('mode')}</span>
              <span className="dshx:break-all">{view.effectiveMode || view.defaultMode}</span>
              <span className="dshx:text-fg-muted">{t('workspace')}</span>
              <span className="dshx:break-all">{view.workspaceRoot}</span>
            </div>
          ) : null}

          {view && view.deploymentRoots && view.deploymentRoots.length > 0 ? (
            <Field label={t('deploymentRoots')}>
              <div>
                {view.deploymentRoots.map((root) => (
                  <div
                    key={root}
                    className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-2.5 dshx:border-t dshx:border-border dshx:py-2 dshx:first:border-t-0"
                  >
                    <div className="dshx:break-all dshx:text-xs dshx:leading-[18px]">{root}</div>
                    <Badge variant="outline">{t('deploymentNote')}</Badge>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}

          {view ? (
            <Field label={t('grants')} className="dshx:mt-4">
              <div>
                {grants.length === 0 ? (
                  <div className="dshx:text-xs dshx:text-fg-muted">{t('noGrants')}</div>
                ) : null}
                {grants.map((grant) => (
                  <div
                    key={grant.path}
                    className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-2.5 dshx:border-t dshx:border-border dshx:py-2 dshx:first:border-t-0"
                  >
                    <div>
                      <div className="dshx:break-all dshx:text-xs dshx:leading-[18px]">
                        {grant.path}
                        <Badge variant="outline" className="dshx:ml-1.5">
                          {grant.source === 'fork' ? t('sourceFork') : t('sourceUser')}
                        </Badge>
                      </div>
                      {grant.coveredBy ? (
                        <div className="dshx:mt-0.5 dshx:text-2xs dshx:leading-4 dshx:text-fg-muted">
                          {t('coveredBy', { path: grant.coveredBy })}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        if (confirmPath !== grant.path) {
                          setConfirmPath(grant.path)
                          return
                        }
                        setConfirmPath(null)
                        mutate('remove', { path: grant.path }).catch(() => {})
                      }}
                    >
                      {confirmPath === grant.path ? t('confirmRevoke') : t('revoke')}
                    </Button>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}

          {view ? (
            <Field label={t('pendingTitle')} className="dshx:mt-4">
              <div>
                {pending.length === 0 ? (
                  <div className="dshx:text-xs dshx:text-fg-muted">{t('noPending')}</div>
                ) : null}
                {pending.map((request) => (
                  <div
                    key={request.requestId}
                    className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-2.5 dshx:border-t dshx:border-border dshx:py-2 dshx:first:border-t-0"
                  >
                    <div>
                      <div className="dshx:break-all dshx:text-xs dshx:leading-[18px]">
                        {request.path}
                      </div>
                      <div className="dshx:mt-0.5 dshx:text-2xs dshx:leading-4 dshx:text-fg-muted">
                        {t('reason')}: {request.reason || t('empty')}
                      </div>
                      <div className="dshx:mt-0.5 dshx:text-2xs dshx:leading-4 dshx:text-fg-muted">
                        {t('requestedBy', { session: String(request.sessionId).slice(-8) })}
                      </div>
                      <div className="dshx:mt-0.5 dshx:text-2xs dshx:leading-4 dshx:text-fg-muted">
                        {t('allowNote')}
                      </div>
                    </div>
                    <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={busy}
                        onClick={() => {
                          mutate('decide', {
                            requestId: request.requestId,
                            decision: 'allow',
                            expectedRevision: view.revision,
                          }).catch(() => {})
                        }}
                      >
                        {t('allow')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          mutate('decide', {
                            requestId: request.requestId,
                            decision: 'deny',
                            expectedRevision: view.revision,
                          }).catch(() => {})
                        }}
                      >
                        {t('deny')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}

          {view ? (
            <Field label={t('addTitle')} className="dshx:mt-4">
              <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
                <Input
                  className="dshx:w-auto dshx:min-w-0 dshx:flex-1"
                  value={path}
                  placeholder={t('addPlaceholder')}
                  onChange={(event) => setPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && path.trim())
                      mutate('add', { path: path.trim() }).catch(() => {})
                  }}
                />
                <Button
                  size="md"
                  variant="default"
                  disabled={busy || !path.trim()}
                  onClick={() => {
                    mutate('add', { path: path.trim() }).catch(() => {})
                  }}
                >
                  {t('add')}
                </Button>
                {workspaceClient && typeof workspaceClient.pickDirectory === 'function' ? (
                  <Button size="md" variant="secondary" disabled={busy} onClick={choose}>
                    {t('pick')}
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}

          {view ? (
            <Field
              label={t('forkTitle')}
              hint={
                <>
                  {t('forkNote')}
                  <br />
                  {t('oldProcessNote')}
                </>
              }
              className="dshx:mt-4"
            >
              <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
                <Input
                  className="dshx:w-auto dshx:max-w-[140px] dshx:min-w-0 dshx:flex-1"
                  value={forkSeq}
                  placeholder={t('forkSeq')}
                  inputMode="numeric"
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
                    fork(parsed)
                  }}
                >
                  {t('fork')}
                </Button>
                <Button size="md" variant="secondary" disabled={busy} onClick={refresh}>
                  {t('refresh')}
                </Button>
              </div>
              {(view.forks ?? []).some((record) => record.stage === 'failed') ? (
                <div className="dshx:mt-2.5 dshx:text-xs dshx:text-danger">
                  {t('forkPreviousFailed')}
                </div>
              ) : null}
            </Field>
          ) : null}

          {recent.length > 0 ? (
            <Field label={t('recent')} className="dshx:mt-4">
              <div>
                {recent.map((request) => (
                  <div
                    key={request.requestId}
                    className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-2.5 dshx:border-t dshx:border-border dshx:py-2 dshx:first:border-t-0"
                  >
                    <div className="dshx:break-all dshx:text-xs dshx:leading-[18px]">
                      {request.path}
                    </div>
                    <Badge variant="outline">{request.status}</Badge>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}

          {shared.notice ? (
            <Alert variant="info" className="dshx:mt-4">
              {shared.notice}
            </Alert>
          ) : null}
          {shared.error ? (
            <Alert variant="error" className="dshx:mt-2.5 dshx:whitespace-pre-wrap">
              {shared.error}
            </Alert>
          ) : null}
        </Dialog>
      </Root>
    )
  }

  ctx.slots.inject('conversation.input.left', () => {
    return ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-session-write-access',
        order: 40,
        label: () => t('panel'),
        inject: () => ({}),
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
        inject: () => ({}),
      },
      Overlay,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale', 'uiWorkspace']
