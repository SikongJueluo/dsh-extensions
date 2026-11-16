// Client half of dsh-jj-workspace: the new-session worktree option replaced
// with a VCS-aware control, plus a compact task-state pill in the Session
// header. The control shadows the stock Forge toggle only in the slot cell
// (`forge-panel.worktree`, priority -1), so unloading this plugin restores the
// stock control. Requests still go through the stock Forge Remote, which keeps
// the first-message hold, progress card, retry, and withdraw lifecycle.
import { useEffect, useState } from 'react'
import {
  Root,
  cn,
  type DshClientContext,
  type SlotRegistration,
  type SlotsService,
} from '@dsh-extensions/ui'
import { WorktreeOption, type WorktreeChoice } from './worktree-option'
import './styles.css'

const LOCALE_NS = 'jj-workspace'
const RPC_BASE = '/dsh-jj-workspace'
const TASK_REFRESH_MS = 10000
const STATUS_RETRY_MS = 2000
/** Non-empty stand-in for the native `<option value="">` (detached HEAD base). */
const DETACHED = '__jjw-detached__'

const en: Record<string, string> = {
  jj: 'jj workspace',
  git: 'worktree',
  hintJj: 'Create a jj workspace from the current change and enter it for this session.',
  hintGit: 'Create a Git worktree from the selected branch and enter it for this session.',
  requested: 'The workspace is created before the first message.',
  baseAt: 'current change (@)',
  baseMenuJj: 'Base change or bookmark',
  baseMenuGit: 'Base branch',
  currentNote: 'current',
  baseHead: 'HEAD',
  detached: 'detached {commit}',
  blockerReadOnly: 'This session is read-only.',
  blockerOutside: "The project pool is outside this session's writable root.",
  blockerJj: 'jj cannot read this workspace.',
  blockerNotGit: 'This directory is not a Git checkout.',
  failed: 'Workspace request failed: {message}',
  taskOk: 'jj: {name}',
  taskMoved: '{name} (moved)',
  taskBookmarkMissing: '{name} (bookmark missing)',
  taskWorkspaceMissing: '{name} (workspace missing)',
  taskConflict: '{name} (conflict)',
  taskUnavailable: '{name} (unavailable)',
  taskDetail: '{workspace} at {path}\nbookmark {bookmark} at {change}\nbase {base}\nstate: {state}',
}

const zh: Record<string, string> = {
  jj: 'jj 工作区',
  git: '工作树',
  hintJj: '从当前 change 创建 jj 工作区，并让本会话在其中工作。',
  hintGit: '从所选分支创建 Git 工作树，并让本会话在其中工作。',
  requested: '首条消息发送前会创建工作区。',
  baseAt: '当前 change (@)',
  baseMenuJj: '基准 change 或 bookmark',
  baseMenuGit: '选择基准分支',
  currentNote: '当前',
  baseHead: 'HEAD',
  detached: 'detached {commit}',
  blockerReadOnly: '本会话是只读的。',
  blockerOutside: '项目池不在本会话的可写根内。',
  blockerJj: 'jj 无法读取该工作区。',
  blockerNotGit: '当前目录不是 Git 检出。',
  failed: '工作区请求失败：{message}',
  taskOk: 'jj：{name}',
  taskMoved: '{name}（已移动）',
  taskBookmarkMissing: '{name}（bookmark 缺失）',
  taskWorkspaceMissing: '{name}（workspace 缺失）',
  taskConflict: '{name}（冲突）',
  taskUnavailable: '{name}（不可读）',
  taskDetail:
    '{workspace} 位于 {path}\nbookmark {bookmark} 指向 {change}\nbase {base}\n状态：{state}',
}

type Translate = (key: string, params?: Record<string, unknown>) => string

interface OperationResult {
  ok?: boolean
  error?: { message?: string }
}

interface WorktreeState {
  created?: boolean | null
  editable?: boolean
  request?: { from?: string | null } | null
  creation?: unknown
  blocker?: string
}

interface CheckoutSnapshot {
  state?: string
  checkout?: { branch?: string | null; commit?: string | null } | null
}

/** The panel stream frame: the stock worktree state plus the checkout facts. */
interface PanelFrame {
  worktree?: WorktreeState | null
  directory?: string
  checkout?: CheckoutSnapshot | null
}

interface VcsStatus {
  kind?: string
  blocker?: string
  bookmarks?: string[]
}

interface BranchList {
  branches?: string[]
}

type BranchesResult = OperationResult & { value?: BranchList }

interface TaskEntry {
  workspace?: string
  path?: string
  bookmark?: string
  currentChangeId?: string
  changeId?: string
  baseChange?: string
  state?: string
}

interface TaskListResult {
  tasks?: TaskEntry[]
}

/** `permissions` session projection (absent key → capability absent). */
interface PermissionSelection {
  currentValue?: string
}

type UseProjection = (key: string) => unknown

interface ForgePanelRemote {
  follow(sessionId: string, signal?: AbortSignal): AsyncIterable<PanelFrame>
  branches(sessionId: string): Promise<BranchesResult>
  requestWorktree(sessionId: string, from: string | null): Promise<OperationResult>
  cancelWorktree(sessionId: string): Promise<OperationResult>
}

/** The plugin scope inside `ctx.inject([...])` once the Forge Remote is mounted. */
interface ForgeScope {
  slots: SlotsService
  remote: Record<string, unknown> & { forgePanel: ForgePanelRemote }
}

/**
 * The client-half context with the runtime `inject` seat the shared type does
 * not pin; the Forge Remote namespace is a service, so the hero cell must wait
 * for it before registering.
 */
interface JjwClientContext extends DshClientContext {
  inject(deps: string[], callback: (scope: ForgeScope) => void): void
}

let rpcSeq = 0

function unwrap<T>(envelope: unknown): T | null {
  if (typeof envelope !== 'object' || envelope === null) return null
  const record = envelope as { type?: unknown; result?: { ok?: unknown; value?: unknown } }
  if (record.type !== 'server-response' || !record.result || record.result.ok !== true) return null
  return record.result.value as T
}

/** POST one plugin-routed RPC; every failure mode folds into `null`. */
function call<T>(sessionId: string, method: string, signal?: AbortSignal): Promise<T | null> {
  rpcSeq += 1
  const rpcId = `jj-workspace-${method}-${String(rpcSeq)}`
  const run = async (): Promise<T | null> => {
    const response = await fetch(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload: { sessionId },
      }),
      signal,
    })
    if (!response.ok) return null
    return unwrap<T>(await response.json())
  }
  return run().catch(() => null)
}

function blockerText(t: Translate, blocker: string | null): string {
  if (blocker === 'read-only') return t('blockerReadOnly')
  if (blocker === 'outside-writable-root') return t('blockerOutside')
  if (blocker === 'jj-unavailable') return t('blockerJj')
  if (blocker === 'not-git') return t('blockerNotGit')
  return ''
}

type ToggleFace = {
  t: Translate
  status: (sessionId: string, signal?: AbortSignal) => Promise<VcsStatus | null>
  follow: (signal?: AbortSignal) => AsyncIterable<PanelFrame>
  branches: () => Promise<BranchesResult>
  request: (from: string | null) => Promise<OperationResult>
  cancel: () => Promise<OperationResult>
}

interface ToggleProps extends ToggleFace {
  sessionId: string
  useProjection: UseProjection
}

function Toggle({
  sessionId,
  t,
  status,
  follow,
  branches,
  request,
  cancel,
  useProjection,
}: ToggleProps) {
  const permissions = useProjection('permissions') as PermissionSelection | undefined
  const permissionValue = permissions?.currentValue
  const [panel, setPanel] = useState<PanelFrame | null>(null)
  const [statusState, setStatusState] = useState<VcsStatus | null>(null)
  const [branchList, setBranchList] = useState<BranchList | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  // The panel stream carries the stock worktree state (editable, request,
  // created, creation, blocker) and the checkout facts. It is the same
  // public state the stock toggle reads.
  useEffect(() => {
    let alive = true
    let controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const start = () => {
      if (!alive) return
      const current = new AbortController()
      controller = current
      void (async () => {
        try {
          const stream = follow(current.signal)
          for await (const frame of stream) {
            if (alive) setPanel(frame)
          }
        } catch {
          // A transport reset or a disposed Remote; retry while mounted.
        }
        if (alive) timer = setTimeout(start, STATUS_RETRY_MS)
      })()
    }
    start()
    return () => {
      alive = false
      controller?.abort()
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const worktree = panel?.worktree ?? null
  const created = !!(worktree && worktree.created)
  const directory = panel?.directory

  useEffect(() => {
    if (created || !worktree || !worktree.editable) {
      setStatusState(null)
      return undefined
    }
    let alive = true
    let controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (!alive) return
      setStatusState(null)
      timer = setTimeout(load, STATUS_RETRY_MS)
    }
    const load = () => {
      if (!alive) return
      const current = new AbortController()
      controller = current
      void status(sessionId, current.signal).then(
        (next) => {
          if (!alive) return
          if (next === null) schedule()
          else setStatusState(next)
        },
        () => {
          schedule()
        },
      )
    }
    // Invalidate the old VCS/permission answer before asking again: a new
    // directory, Session, or permission value must not keep old semantics.
    setStatusState(null)
    setBranchList(null)
    load()
    return () => {
      alive = false
      controller?.abort()
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, directory, created, worktree && worktree.editable, permissionValue])

  const requested = !!(worktree && worktree.request !== null)
  const kind = statusState && statusState.kind
  const jj = kind === 'jj'
  const gitBlocker = worktree ? worktree.blocker : null
  const blocker = jj
    ? statusState?.blocker === undefined
      ? null
      : statusState.blocker
    : gitBlocker === undefined
      ? null
      : gitBlocker
  const usable = blocker === null
  const readyCheckout =
    !jj && panel && panel.checkout && panel.checkout.state === 'ready'
      ? (panel.checkout.checkout ?? null)
      : null
  const currentBranch = readyCheckout && readyCheckout.branch ? readyCheckout.branch : null
  const currentCommit = readyCheckout && readyCheckout.commit ? readyCheckout.commit : null

  // Only the Git arm needs the stock branch list; the jj arm uses the
  // status channel's local bookmark names. Keep this hook before every
  // conditional return so the hook order never changes.
  useEffect(() => {
    if (kind !== 'git' || !requested || !usable || branchList !== null) return undefined
    let alive = true
    void branches().then(
      (result) => {
        if (alive && result && result.ok) setBranchList(result.value ?? null)
      },
      () => {},
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, requested, usable, branchList])

  if (!worktree || created || !worktree.editable) return null
  if (!kind || kind === 'none') return null
  if (!jj) {
    if (!panel || !panel.checkout || panel.checkout.state !== 'ready') return null
    if (worktree.blocker === 'not-git') return null
  }
  const held = worktree.creation !== null
  const disabled = held || pending || (!usable && !requested)
  const from: string | null = requested && worktree ? (worktree.request?.from ?? null) : null
  const baseValue = jj ? (from === null ? '@' : from) : from === null ? currentBranch : from
  const baseText = jj
    ? from === null
      ? t('baseAt')
      : from
    : from !== null
      ? from
      : requested
        ? t('baseHead')
        : currentBranch !== null
          ? currentBranch
          : t('detached', { commit: currentCommit || '?' })
  const reason = error || blockerText(t, blocker)
  const hint = reason || (requested ? t('requested') : jj ? t('hintJj') : t('hintGit'))

  const change = (checked: boolean) => {
    if (pending || disabled) return
    setPending(true)
    setError('')
    const next = checked ? (jj ? null : currentBranch) : null
    const operation = checked ? request(next) : cancel()
    void operation
      .then(
        (result) => {
          if (!result || result.ok !== true) {
            setError(t('failed', { message: result?.error?.message || 'unknown error' }))
          }
        },
        (failure: unknown) => {
          const reason = failure as { message?: unknown } | null
          setError(
            t('failed', {
              message: String(reason && reason.message ? reason.message : failure),
            }),
          )
        },
      )
      .then(() => {
        setPending(false)
      })
  }

  const pick = (value: string) => {
    if (pending || held) return
    setPending(true)
    setError('')
    const next = value === '' || (jj && value === '@') ? null : value
    void request(next)
      .then(
        (result) => {
          if (!result || result.ok !== true) {
            setError(t('failed', { message: result?.error?.message || 'unknown error' }))
          }
        },
        (failure: unknown) => {
          const reason = failure as { message?: unknown } | null
          setError(
            t('failed', {
              message: String(reason && reason.message ? reason.message : failure),
            }),
          )
        },
      )
      .then(() => {
        setPending(false)
      })
  }

  let choices: WorktreeChoice[] = []
  if (requested && usable) {
    const optionValues: string[] = []
    if (jj) {
      const names = (statusState?.bookmarks ?? []).slice()
      if (from !== null && !names.includes(from)) names.unshift(from)
      optionValues.push('@', ...names)
    } else {
      const listed =
        branchList && Array.isArray(branchList.branches) ? branchList.branches.slice() : []
      if (from !== null && !listed.includes(from)) listed.unshift(from)
      if (currentBranch !== null && !listed.includes(currentBranch)) listed.unshift(currentBranch)
      if (currentBranch === null && baseValue === '') optionValues.push(DETACHED)
      optionValues.push(...listed)
    }
    choices = optionValues.map((name) => ({
      value: name === '' ? DETACHED : name,
      label:
        name === '@'
          ? t('baseAt')
          : name === ''
            ? t('detached', { commit: currentCommit || '?' })
            : name,
      note: !jj && name === currentBranch ? t('currentNote') : undefined,
    }))
  }

  return (
    <WorktreeOption
      kind={jj ? 'jj' : 'git'}
      label={jj ? t('jj') : t('git')}
      menuLabel={jj ? t('baseMenuJj') : t('baseMenuGit')}
      requested={requested}
      usable={usable}
      disabled={disabled}
      baseText={baseText}
      hint={hint}
      choices={choices}
      selected={baseValue === '' || baseValue === null ? DETACHED : baseValue}
      error={error}
      onCheckedChange={change}
      onPick={(value) => {
        pick(value === DETACHED ? '' : value)
      }}
    />
  )
}

interface TaskPillProps {
  sessionId: string
  t: Translate
  tasks: () => Promise<TaskListResult | null>
}

function TaskPill({ sessionId, t, tasks }: TaskPillProps) {
  const [list, setList] = useState<TaskEntry[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      void tasks().then(
        (value) => {
          if (alive) setList(value && Array.isArray(value.tasks) ? value.tasks : [])
        },
        () => {
          if (alive) setList([])
        },
      )
    }
    load()
    const timer = setInterval(load, TASK_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (!list || list.length === 0) return null
  const task = list[list.length - 1]
  if (!task) return null
  const state = task.state || 'unavailable'
  const labelKey =
    state === 'ok'
      ? 'taskOk'
      : state === 'moved'
        ? 'taskMoved'
        : state === 'bookmark-missing'
          ? 'taskBookmarkMissing'
          : state === 'workspace-missing'
            ? 'taskWorkspaceMissing'
            : state === 'conflict'
              ? 'taskConflict'
              : 'taskUnavailable'
  const dotClass = cn(
    'dshx:size-[7px] dshx:shrink-0 dshx:rounded-full dshx:bg-fg-muted',
    state === 'ok' && 'dshx:bg-ok',
    state === 'moved' && 'dshx:bg-warn',
    (state === 'bookmark-missing' || state === 'workspace-missing' || state === 'conflict') &&
      'dshx:bg-danger',
  )
  return (
    <Root className="dshx:min-w-0">
      <span
        data-state={state}
        title={t('taskDetail', {
          workspace: task.workspace,
          path: task.path,
          bookmark: task.bookmark,
          change: task.currentChangeId || task.changeId,
          base: task.baseChange,
          state,
        })}
        className="dshx:inline-flex dshx:h-7 dshx:max-w-[min(180px,40vw)] dshx:cursor-default dshx:items-center dshx:gap-1.5 dshx:overflow-hidden dshx:px-2 dshx:rounded-[6px] dshx:text-ellipsis dshx:text-xs dshx:leading-[18px] dshx:text-fg-secondary dshx:whitespace-nowrap dshx:pointer-coarse:h-9"
      >
        <span className={dotClass} />
        {t(labelKey, { name: task.workspace })}
      </span>
    </Root>
  )
}

type WorktreeCellOptions = Omit<SlotRegistration, 'inject'> & {
  /** Overrides the stock Forge cell in the same slot position. */
  priority: number
  inject: (sessionId: string | undefined) => ToggleFace
}

type TaskCellOptions = Omit<SlotRegistration, 'inject'> & {
  inject: (sessionId: string | undefined) => {
    t: Translate
    tasks: () => Promise<TaskListResult | null>
  }
}

function apply(ctx: JjwClientContext) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'dsh-jj-workspace: locale')
  const t = ctx.locale.bind(LOCALE_NS)

  ctx.inject(['remote.forgePanel'], (scope) => {
    scope.slots.inject('conversation.hero.options', () => {
      const registration: WorktreeCellOptions = {
        name: 'conversation.hero.options',
        id: 'forge-panel.worktree',
        priority: -1,
        order: 0,
        locale: LOCALE_NS,
        inject: (sessionId) => {
          const id = sessionId ?? ''
          return {
            t,
            status: (target, signal) => call<VcsStatus>(target, 'status', signal),
            follow: (signal) => scope.remote.forgePanel.follow(id, signal),
            branches: () => scope.remote.forgePanel.branches(id),
            request: (from) => scope.remote.forgePanel.requestWorktree(id, from),
            cancel: () => scope.remote.forgePanel.cancelWorktree(id),
          }
        },
      }
      return scope.slots.register(registration, Toggle)
    })
  })

  ctx.slots.inject('conversation.session.header.utilities', () => {
    const registration: TaskCellOptions = {
      name: 'conversation.session.header.utilities',
      id: 'jj-workspace.task',
      order: -7,
      locale: LOCALE_NS,
      inject: (sessionId) => ({
        t,
        tasks: () => call<TaskListResult>(sessionId ?? '', 'tasks'),
      }),
    }
    return ctx.slots.register(registration, TaskPill)
  })
}

export { apply }
export const inject = ['slots', 'locale', 'remote']
