// Client half of dsh-triggers: the current Session's trigger view.
//
// One Conversation tab (order 30) shows the execute/review loops THIS session
// takes part in — as executor or as reviewer — with the real run state, the
// reason it stopped, the controls the host accepts, and a read-only view of the
// binding. The host owns every transition; this half only reads
// `/dsh-triggers/state?sessionId=…` and posts run controls. There is no global
// template editor, no binding creation form, and no session-header control.
//
// TypeScript + JSX on the shared `@dsh-extensions/ui` components; styles come
// from the bundled `./styles.css` Tailwind entry (`dshx:`-prefixed utilities
// only). Touch-first: actions are click targets ≥ 44px on coarse pointers,
// widths shrink with the viewport, and hover is only an enhancement.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Badge, Button, Input, Root, cn, type DshClientContext } from '@dsh-extensions/ui'
import './styles.css'

const RPC_BASE = '/dsh-triggers'
const LOCALE_NS = 'triggers'
const POLL_MS = 10000
const HISTORY_SHOWN = 6
const DELIVERY_SHOWN = 5

type Translate = (key: string, params?: Record<string, unknown>) => string

interface HistoryEntry {
  kind: string
  at: number
  detail?: string
}

interface TriggerRun {
  id: string
  bindingId?: string
  executor?: string
  parent?: string
  status: string
  phase?: string
  round: number
  maxRounds: number
  startedAt: number
  endedAt?: number
  task?: string
  pausedBy?: string
  pendingRework?: { summary: string }
  pendingSignal?: boolean
  endNote?: string
  history?: HistoryEntry[]
}

interface TemplateRefs {
  start?: string
  review?: string
  rework?: string
}

interface TriggerBinding {
  id: string
  name?: string
  executor: string
  parent: string
  maxRounds: number
  autoDeliver: boolean
  enabled?: boolean
  templates?: TemplateRefs
}

interface Delivery {
  id: string
  runId: string
  kind: string
  to?: string
  state: string
  createdAt: number
  error?: string
  round?: number
}

interface TemplateRecord {
  id: string
  name?: string
}

interface StatePayload {
  templates?: TemplateRecord[]
  bindings?: TriggerBinding[]
  runs?: TriggerRun[]
  deliveries?: Delivery[]
}

interface ScopedSnapshot {
  templates: TemplateRecord[]
  bindings: TriggerBinding[]
  runs: TriggerRun[]
  deliveries: Delivery[]
}

type Role = 'executor' | 'parent'

interface RunGroup {
  id: string
  binding?: TriggerBinding
  runs: TriggerRun[]
  current?: TriggerRun
  role?: Role
  peer?: string
}

interface SessionRow {
  displayTitle?: string
  title?: string
}

type SessionsById = Record<string, SessionRow>

/** `run.control` posts and any future endpoint; the host answers `{ok,value}`. */
type ActionFn = (endpoint: string, payload: Record<string, unknown>) => Promise<boolean>

interface RpcResult<T> {
  ok?: boolean
  value?: T
  error?: { message?: string }
}

interface RpcEnvelope<T> {
  result?: RpcResult<T>
}

function callRpc<T>(endpoint: string, payload?: Record<string, unknown>): Promise<T> {
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30000) : undefined
  return fetch(`${RPC_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'triggers-' + String(Date.now()) + '-' + String(Math.random()).slice(2),
      method: endpoint,
      payload: payload ?? {},
    }),
  })
    .then((response) => response.json() as Promise<RpcEnvelope<T>>)
    .then((body) => {
      const result = body?.result
      if (result && result.ok) return result.value as T
      const message = result && result.error ? result.error.message : 'channel error'
      throw new Error(message)
    })
}

const zh: Record<string, string> = {
  viewLabel: '触发器',
  title: '触发器',
  refresh: '刷新',
  loading: '加载中…',
  loadFailed: '读取失败：{message}',
  retry: '重试',
  close: '关闭',
  noSession: '没有选中的会话。',
  activeSummary: '{n} 个运行进行中',
  emptyTitle: '当前会话暂无关联触发器。',
  emptyHint: '通过交接流程建立的循环会显示在这里。',
  roleExecutor: '你是执行者',
  roleReviewer: '你是审核者',
  peerExecutor: '执行者',
  peerReviewer: '审核者',
  unknownSession: '会话不可见',
  round: '第 {round}/{max} 轮',
  noRun: '尚未启动',
  noRunHint: '绑定已建立，等待第一次运行。',
  statusActiveDelivery: '等待交付',
  statusActiveReview: '等待审核',
  statusPausedUser: '等待用户',
  statusPausedBudget: '预算用尽',
  statusPausedError: '异常暂停',
  statusCompleted: '已完成',
  statusCancelled: '已取消',
  reasonAwaitingDeliverySelf: '等待你完成本回合并交付。',
  reasonAwaitingDeliveryPeer: '等待执行者完成本回合并交付。',
  reasonAwaitingReviewSelf: '等待你提交 rework / pass / needs_user 裁决。',
  reasonAwaitingReviewPeer: '等待审核者提交裁决。',
  reasonPausedUser: '等待用户处理后恢复。',
  reasonPausedUserSelf: '本会话提出了需要用户决定的事项，等待用户处理后恢复。',
  reasonPausedUserPeer: '对方提出了需要用户决定的事项，等待用户处理后恢复。',
  reasonPausedBudget: '轮次预算已用尽；续一轮后可以继续。',
  reasonPausedBudgetRework: '轮次预算已用尽；待返工的审核意见：{summary}',
  reasonPausedError: '运行因异常暂停；请查看投递错误，或恢复后重试。',
  reasonCompleted: '运行已完成。',
  reasonCancelled: '运行已取消。',
  pendingSignalNote: '本回合已有待提交信号；回合结束后按该信号推进。',
  endNote: '备注',
  pause: '暂停',
  resume: '恢复',
  resumeNotePlaceholder: '随恢复带给对方的说明（可空）',
  extend: '续一轮',
  cancel: '取消',
  confirmCancel: '取消该运行？',
  redeliver: '重投',
  actionFailed: '操作失败：{message}',
  details: '详情',
  otherRuns: '其他运行',
  historyTitle: '历史',
  historyTruncated: '最近 {shown} 条，共 {total} 条',
  deliveriesTitle: '投递',
  attentionDeliveries: '需要处理',
  sentDeliveries: '已送达',
  deliveriesTruncated: '最近 {shown} 条，共 {total} 条',
  deliveryTo: '→ {to}',
  deliveryError: '错误：{message}',
  configTitle: '配置',
  configExecutor: '执行会话',
  configReviewer: '审核会话',
  configRounds: '轮次预算',
  configAuto: '自动送审',
  configTemplates: '模板',
  configEnabled: '绑定状态',
  configEnabledOn: '启用',
  configDisabled: '已停用',
  configHint: '配置来自交接流程，本页只读。',
  autoOn: '开',
  autoOff: '关',
  missingBindingNote: '绑定配置当前不可见；以下运行保留启动时的会话快照。',
  snapshotNote: '当前绑定已改配对；本次运行仍按启动时的会话快照显示。',
  untitledRun: '未命名运行',
  tplStart: '开工',
  tplReview: '送审',
  tplRework: '返工',
  expand: '展开详情',
  collapse: '收起详情',
  statePending: '待发送',
  stateSent: '已送达',
  stateFailed: '失败',
  kindStart: '开工',
  kindReview: '送审',
  kindRework: '返工',
  kindNotice: '通知',
  kindResume: '恢复',
  kindNudge: '提醒',
  histStarted: '启动',
  histSignal: '信号',
  histAdvance: '推进',
  histPause: '暂停',
  histResume: '恢复',
  histEnd: '结束',
  histNote: '备注',
  histDelivery: '投递',
  histNudge: '提醒',
}

const en: Record<string, string> = {
  viewLabel: 'Triggers',
  title: 'Triggers',
  refresh: 'Refresh',
  loading: 'Loading…',
  loadFailed: 'Could not load: {message}',
  retry: 'Retry',
  close: 'Dismiss',
  noSession: 'No session selected.',
  activeSummary: '{n} runs active',
  emptyTitle: 'No triggers are associated with this session.',
  emptyHint: 'Loops created by a handoff appear here.',
  roleExecutor: 'You are the executor',
  roleReviewer: 'You are the reviewer',
  peerExecutor: 'Executor',
  peerReviewer: 'Reviewer',
  unknownSession: 'session unavailable',
  round: 'round {round}/{max}',
  noRun: 'Not started',
  noRunHint: 'The binding exists; waiting for its first run.',
  statusActiveDelivery: 'Awaiting delivery',
  statusActiveReview: 'Awaiting review',
  statusPausedUser: 'Waiting for user',
  statusPausedBudget: 'Round budget spent',
  statusPausedError: 'Paused on error',
  statusCompleted: 'Completed',
  statusCancelled: 'Cancelled',
  reasonAwaitingDeliverySelf: 'Waiting for you to finish this round and deliver.',
  reasonAwaitingDeliveryPeer: 'Waiting for the executor to finish this round and deliver.',
  reasonAwaitingReviewSelf: 'Waiting for your rework / pass / needs_user verdict.',
  reasonAwaitingReviewPeer: "Waiting for the reviewer's verdict.",
  reasonPausedUser: 'Waiting for the user to resolve it, then resume.',
  reasonPausedUserSelf: 'This session raised a decision for the user; the loop resumes afterwards.',
  reasonPausedUserPeer:
    'The other side raised a decision for the user; the loop resumes afterwards.',
  reasonPausedBudget: 'The round budget is spent; extend it to continue.',
  reasonPausedBudgetRework: 'The round budget is spent; pending rework: {summary}',
  reasonPausedError: 'The run paused on an error; check delivery errors or resume to retry.',
  reasonCompleted: 'The run completed.',
  reasonCancelled: 'The run was cancelled.',
  pendingSignalNote: 'A signal is already pending this turn; the run advances when the turn ends.',
  endNote: 'Note',
  pause: 'Pause',
  resume: 'Resume',
  resumeNotePlaceholder: 'Optional note to deliver with the resume',
  extend: '+1 round',
  cancel: 'Cancel',
  confirmCancel: 'Cancel this run?',
  redeliver: 'Resend',
  actionFailed: 'Action failed: {message}',
  details: 'Details',
  otherRuns: 'Other runs',
  historyTitle: 'History',
  historyTruncated: 'latest {shown} of {total}',
  deliveriesTitle: 'Deliveries',
  attentionDeliveries: 'Needs attention',
  sentDeliveries: 'Sent',
  deliveriesTruncated: 'latest {shown} of {total}',
  deliveryTo: '→ {to}',
  deliveryError: 'Error: {message}',
  configTitle: 'Configuration',
  configExecutor: 'Executor',
  configReviewer: 'Reviewer',
  configRounds: 'Round budget',
  configAuto: 'Auto-deliver',
  configTemplates: 'Templates',
  configEnabled: 'Binding',
  configEnabledOn: 'enabled',
  configDisabled: 'disabled',
  configHint: 'Set by the handoff; read-only here.',
  autoOn: 'on',
  autoOff: 'off',
  missingBindingNote:
    'The binding configuration is not visible here; runs below keep their start-time session snapshot.',
  snapshotNote: 'The binding pair changed; this run still follows its start-time session snapshot.',
  untitledRun: 'Untitled run',
  tplStart: 'Start',
  tplReview: 'Review',
  tplRework: 'Rework',
  expand: 'Expand details',
  collapse: 'Collapse details',
  statePending: 'pending',
  stateSent: 'sent',
  stateFailed: 'failed',
  kindStart: 'start',
  kindReview: 'review',
  kindRework: 'rework',
  kindNotice: 'notice',
  kindResume: 'resume',
  kindNudge: 'nudge',
  histStarted: 'started',
  histSignal: 'signal',
  histAdvance: 'advanced',
  histPause: 'paused',
  histResume: 'resumed',
  histEnd: 'ended',
  histNote: 'note',
  histDelivery: 'delivery',
  histNudge: 'nudge',
}

function template(text: string, vars: Record<string, unknown>): string {
  return String(text).replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] === undefined ? '' : String(vars[key]),
  )
}

function messageOf(error: unknown): string {
  const candidate = error as { message?: unknown } | undefined | null
  return candidate && candidate.message ? String(candidate.message) : String(error)
}

function fmtTime(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  )
}

// Host session ids share long common prefixes (`session-<uuid>` or plain
// `session-<n>`); a fixed head slice collapses them. Strip the prefix and
// abbreviate the tail instead. Titles are the primary label and this is
// the fallback for a session missing from the client catalog.
function shortId(id: string): string {
  const raw = String(id).replace(/^session-/, '')
  if (raw.length <= 10) return raw
  return raw.slice(0, 4) + '…' + raw.slice(-4)
}

function safeId(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '-')
}

function sessionLabel(t: Translate, sessionsById: SessionsById, id: string | undefined): string {
  if (typeof id !== 'string' || id.length === 0) return t('unknownSession')
  const row = sessionsById[id]
  if (row) {
    const title = row.displayTitle || row.title
    if (typeof title === 'string' && title.length > 0) return title
    return shortId(id)
  }
  // Before the Session catalog arrives, absence is not evidence of a lost
  // session; show the distinguishable short id without the warning.
  const catalogKnown =
    sessionsById !== undefined && sessionsById !== null && Object.keys(sessionsById).length > 0
  return shortId(id) + (catalogKnown ? ' · ' + t('unknownSession') : '')
}

function roleOf(
  record: TriggerRun | TriggerBinding | undefined,
  sessionId: string,
): Role | undefined {
  if (!record) return undefined
  if (record.executor === sessionId) return 'executor'
  if (record.parent === sessionId) return 'parent'
  return undefined
}

function peerOf(
  record: TriggerRun | TriggerBinding | undefined,
  sessionId: string,
): string | undefined {
  if (!record) return undefined
  if (record.executor === sessionId) return record.parent
  if (record.parent === sessionId) return record.executor
  return undefined
}

const STATUS_KEYS: Record<string, string> = {
  'paused-user': 'statusPausedUser',
  'paused-budget': 'statusPausedBudget',
  'paused-error': 'statusPausedError',
  completed: 'statusCompleted',
  cancelled: 'statusCancelled',
}
const HISTORY_KEYS: Record<string, string> = {
  started: 'histStarted',
  signal: 'histSignal',
  advance: 'histAdvance',
  pause: 'histPause',
  resume: 'histResume',
  end: 'histEnd',
  note: 'histNote',
  delivery: 'histDelivery',
  nudge: 'histNudge',
}
const KIND_KEYS: Record<string, string> = {
  start: 'kindStart',
  review: 'kindReview',
  rework: 'kindRework',
  notice: 'kindNotice',
  resume: 'kindResume',
  nudge: 'kindNudge',
}
const DELIVERY_STATE_KEYS: Record<string, string> = {
  pending: 'statePending',
  sent: 'stateSent',
  failed: 'stateFailed',
}

type Tone = 'idle' | 'success' | 'warn' | 'error'

const TONE_TEXT: Record<Tone, string> = {
  success: 'dshx:text-ok',
  warn: 'dshx:text-warn',
  error: 'dshx:text-danger',
  idle: 'dshx:text-fg-muted',
}

const TONE_DOT: Record<Tone, string> = {
  success: 'dshx:bg-ok',
  warn: 'dshx:bg-warn',
  error: 'dshx:bg-danger',
  idle: 'dshx:bg-fg-muted',
}

const STATE_CLASS = 'dshx:whitespace-nowrap dshx:text-xs dshx:leading-[1.4]'
const NOTE_CLASS = 'dshx:text-sm dshx:leading-[1.6] dshx:text-fg-secondary'
const SUBLABEL_CLASS = 'dshx:mb-1 dshx:text-2xs dshx:leading-[1.5] dshx:text-fg-secondary'
const HINT_CLASS = 'dshx:mt-2 dshx:text-xs dshx:leading-[1.55] dshx:text-fg-secondary'

function runStateText(t: Translate, run: TriggerRun | undefined): string {
  if (!run) return t('noRun')
  if (run.status === 'active') {
    return run.phase === 'awaiting-review' ? t('statusActiveReview') : t('statusActiveDelivery')
  }
  return t(STATUS_KEYS[run.status] ?? run.status)
}

function statusTone(status: string): Tone {
  if (status === 'active') return 'success'
  if (status === 'paused-user' || status === 'paused-budget') return 'warn'
  if (status === 'paused-error') return 'error'
  return 'idle'
}

function groupTitle(t: Translate, group: RunGroup): string {
  const run = group.current
  if (run && typeof run.task === 'string' && run.task.trim().length > 0) return run.task
  const binding = group.binding
  if (binding && typeof binding.name === 'string' && binding.name.trim().length > 0) {
    return binding.name
  }
  return t('untitledRun')
}

const RUN_RANK: Record<string, number> = {
  'paused-error': 0,
  'paused-user': 1,
  'paused-budget': 2,
  active: 3,
  completed: 4,
  cancelled: 5,
}

function pickCurrentRun(runs: TriggerRun[]): TriggerRun | undefined {
  return runs.slice().sort((left, right) => {
    const leftRank = RUN_RANK[left.status] ?? 9
    const rightRank = RUN_RANK[right.status] ?? 9
    return leftRank - rightRank || right.startedAt - left.startedAt
  })[0]
}

const GROUP_RANK: Record<string, number> = {
  'paused-error': 0,
  'paused-user': 1,
  'paused-budget': 2,
  active: 3,
  completed: 5,
  cancelled: 6,
}

function groupRank(group: RunGroup): number {
  if (!group.current) return 4
  return GROUP_RANK[group.current.status] ?? 7
}

function groupActivity(group: RunGroup): number {
  let latest = 0
  for (const run of group.runs) {
    latest = Math.max(latest, run.startedAt || 0, run.endedAt || 0)
  }
  return latest
}

/** Defensive client-side scope: the host already filters before limiting,
 * but a stale/replayed response must never leak another session's rows. */
function scopeSnapshot(data: StatePayload, sessionId: string): ScopedSnapshot {
  const bindings = (data.bindings ?? []).filter(
    (binding) => binding.executor === sessionId || binding.parent === sessionId,
  )
  const runs = (data.runs ?? []).filter(
    (run) => run.executor === sessionId || run.parent === sessionId,
  )
  const runIds = new Set<string>()
  for (const run of runs) runIds.add(run.id)
  const deliveries = (data.deliveries ?? []).filter((delivery) => runIds.has(delivery.runId))
  return {
    templates: data.templates ?? [],
    bindings,
    runs,
    deliveries,
  }
}

function buildGroups(data: ScopedSnapshot, sessionId: string): RunGroup[] {
  const groups: RunGroup[] = []
  const byBinding = new Map<string, RunGroup>()
  for (const binding of data.bindings) {
    const group: RunGroup = { id: binding.id, binding, runs: [] }
    byBinding.set(binding.id, group)
    groups.push(group)
  }
  for (const run of data.runs) {
    let group = run.bindingId ? byBinding.get(run.bindingId) : undefined
    if (group === undefined) {
      group = { id: run.bindingId || `run-${run.id}`, runs: [] }
      byBinding.set(group.id, group)
      groups.push(group)
    }
    group.runs.push(run)
  }
  for (const group of groups) {
    group.runs.sort((left, right) => right.startedAt - left.startedAt)
    group.current = pickCurrentRun(group.runs)
    const record = group.current ?? group.binding
    group.role = roleOf(record, sessionId)
    group.peer = peerOf(record, sessionId)
  }
  groups.sort(
    (left, right) =>
      groupRank(left) - groupRank(right) || groupActivity(right) - groupActivity(left),
  )
  return groups
}

function runReason(t: Translate, run: TriggerRun, role: Role | undefined): string {
  if (run.status === 'active') {
    if (run.phase === 'awaiting-review') {
      return role === 'parent' ? t('reasonAwaitingReviewSelf') : t('reasonAwaitingReviewPeer')
    }
    return role === 'executor' ? t('reasonAwaitingDeliverySelf') : t('reasonAwaitingDeliveryPeer')
  }
  if (run.status === 'paused-user') {
    if (run.pausedBy === undefined) return t('reasonPausedUser')
    return run.pausedBy === role ? t('reasonPausedUserSelf') : t('reasonPausedUserPeer')
  }
  if (run.status === 'paused-budget') {
    return run.pendingRework
      ? t('reasonPausedBudgetRework', { summary: run.pendingRework.summary })
      : t('reasonPausedBudget')
  }
  if (run.status === 'paused-error') {
    const detail = lastStopDetail(run)
    return detail === undefined ? t('reasonPausedError') : t('reasonPausedError') + ' ' + detail
  }
  if (run.status === 'completed') return t('reasonCompleted')
  if (run.status === 'cancelled') return t('reasonCancelled')
  return ''
}

function lastStopDetail(run: TriggerRun): string | undefined {
  const history = run.history ?? []
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    if (
      entry &&
      (entry.kind === 'pause' || entry.kind === 'end') &&
      typeof entry.detail === 'string' &&
      entry.detail.length > 0
    ) {
      return entry.detail
    }
  }
  return undefined
}

/** Redelivery is offered only when the server would accept it: the run is
 * active (retry the send) or parked by that delivery's failure (resume and
 * resend), AND the delivery belongs to the round and side the run is
 * currently waiting on. Terminal runs, user/budget pauses, and stale
 * rounds are all refused server-side. */
function canRedeliver(run: TriggerRun, delivery: Delivery): boolean {
  if (!delivery || delivery.state !== 'failed') return false
  if (run.status !== 'active' && run.status !== 'paused-error') return false
  if (delivery.round !== run.round) return false
  if (delivery.kind === 'review') return run.phase === 'awaiting-review'
  if (delivery.kind === 'start' || delivery.kind === 'rework') {
    return run.phase === 'awaiting-delivery'
  }
  return true
}

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(
        'dshx:shrink-0 dshx:transition-transform dshx:duration-150 dshx:motion-reduce:transition-none',
        open && 'dshx:rotate-180',
        className,
      )}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

/** Tone-colored outline chip (state/kind labels). */
function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      className={cn('dshx:border-border', tone !== 'idle' ? TONE_TEXT[tone] : undefined)}
    >
      {children}
    </Badge>
  )
}

function Fact({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('dshx:min-w-0', wide && 'dshx:col-span-full')}>
      <div className="dshx:text-2xs dshx:leading-[1.5] dshx:text-fg-muted">{label}</div>
      <div className="dshx:mt-0.5 dshx:text-xs dshx:leading-[1.5] dshx:text-fg-secondary dshx:[overflow-wrap:anywhere]">
        {value}
      </div>
    </div>
  )
}

function ConfigFacts(props: {
  t: Translate
  binding: TriggerBinding
  sessionsById: SessionsById
  templates: TemplateRecord[]
}) {
  const { t, binding, sessionsById } = props
  const templatesById = new Map<string, TemplateRecord>()
  for (const record of props.templates) templatesById.set(record.id, record)
  function templateName(id?: string): string {
    const record = id ? templatesById.get(id) : undefined
    if (record && typeof record.name === 'string' && record.name.length > 0) return record.name
    return id || '—'
  }
  const refs = binding.templates ?? {}
  const templatesLine =
    t('tplStart') +
    ' ' +
    templateName(refs.start) +
    ' · ' +
    t('tplReview') +
    ' ' +
    templateName(refs.review) +
    ' · ' +
    t('tplRework') +
    ' ' +
    templateName(refs.rework)
  return (
    <section
      aria-label={t('configTitle')}
      className="dshx:mt-5 dshx:border-t dshx:border-border dshx:pt-3.5"
    >
      <div className="dshx:mt-2 dshx:grid dshx:grid-cols-2 dshx:gap-x-6 dshx:gap-y-3 dshx:max-[600px]:grid-cols-1 dshx:max-[600px]:gap-y-2.5">
        <Fact label={t('configExecutor')} value={sessionLabel(t, sessionsById, binding.executor)} />
        <Fact label={t('configReviewer')} value={sessionLabel(t, sessionsById, binding.parent)} />
        <Fact label={t('configRounds')} value={String(binding.maxRounds)} />
        <Fact label={t('configAuto')} value={binding.autoDeliver ? t('autoOn') : t('autoOff')} />
        <Fact
          label={t('configEnabled')}
          value={binding.enabled === false ? t('configDisabled') : t('configEnabledOn')}
        />
        <Fact label={t('configTemplates')} value={templatesLine} wide />
      </div>
      <p className={HINT_CLASS}>{t('configHint')}</p>
    </section>
  )
}

function HistoryList({ t, run }: { t: Translate; run: TriggerRun }) {
  const history = run.history ?? []
  if (history.length === 0) return null
  const shown = history.slice(-HISTORY_SHOWN)
  return (
    <div className="dshx:mt-3.5">
      <div className={SUBLABEL_CLASS}>
        {t('historyTitle') +
          (history.length > shown.length
            ? ' · ' + t('historyTruncated', { shown: shown.length, total: history.length })
            : '')}
      </div>
      {shown.map((entry, index) => (
        <div
          key={index}
          className="dshx:grid dshx:grid-cols-[70px_minmax(0,1fr)] dshx:gap-2.5 dshx:border-b dshx:border-border dshx:py-[7px] dshx:text-xs dshx:leading-[1.5] dshx:text-fg-secondary dshx:max-[600px]:grid-cols-[58px_minmax(0,1fr)] dshx:max-[600px]:gap-2"
        >
          <span className="dshx:whitespace-nowrap dshx:tabular-nums dshx:text-fg-muted">
            {fmtTime(entry.at)}
          </span>
          <span className="dshx:min-w-0 dshx:[overflow-wrap:anywhere]">
            {t(HISTORY_KEYS[entry.kind] ?? entry.kind) + (entry.detail ? ' · ' + entry.detail : '')}
          </span>
        </div>
      ))}
    </div>
  )
}

function DeliveryList(props: {
  t: Translate
  run: TriggerRun
  deliveries: Delivery[]
  sessionsById: SessionsById
  onAction: ActionFn
  title?: string
  limit?: number
}) {
  const { t, run, sessionsById, onAction } = props
  const deliveries = props.deliveries ?? []
  const [busy, setBusy] = useState<string | null>(null)

  if (deliveries.length === 0) return null
  const limit = typeof props.limit === 'number' ? props.limit : DELIVERY_SHOWN
  const shown = deliveries.slice(0, limit)

  function resend(delivery: Delivery) {
    if (busy !== null) return
    setBusy(delivery.id)
    void Promise.resolve(
      onAction('run.control', {
        runId: delivery.runId,
        action: 'redeliver',
        deliveryId: delivery.id,
      }),
    ).finally(() => {
      setBusy(null)
    })
  }

  return (
    <div className="dshx:mt-3.5">
      <div className={SUBLABEL_CLASS}>{props.title || t('deliveriesTitle')}</div>
      {shown.map((delivery) => (
        <div
          key={delivery.id}
          className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2 dshx:border-b dshx:border-border dshx:py-2"
        >
          <Chip tone="idle">{t(KIND_KEYS[delivery.kind] ?? delivery.kind)}</Chip>
          <span className="dshx:text-xs dshx:text-fg-secondary">
            {t('deliveryTo', { to: sessionLabel(t, sessionsById, delivery.to) }) +
              ' · ' +
              fmtTime(delivery.createdAt)}
          </span>
          <span
            className={cn(
              STATE_CLASS,
              delivery.state === 'failed'
                ? 'dshx:text-danger'
                : delivery.state === 'sent'
                  ? 'dshx:text-ok'
                  : 'dshx:text-warn',
            )}
          >
            {t(DELIVERY_STATE_KEYS[delivery.state] ?? delivery.state)}
          </span>
          {canRedeliver(run, delivery) ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => resend(delivery)}
            >
              {t('redeliver')}
            </Button>
          ) : null}
          {delivery.error ? (
            <span className="dshx:flex-[1_1_100%] dshx:text-xs dshx:leading-[1.5] dshx:text-danger dshx:[overflow-wrap:anywhere]">
              {t('deliveryError', { message: delivery.error })}
            </span>
          ) : null}
        </div>
      ))}
      {deliveries.length > shown.length ? (
        <p className={HINT_CLASS}>
          {t('deliveriesTruncated', { shown: shown.length, total: deliveries.length })}
        </p>
      ) : null}
    </div>
  )
}

function RunActions(props: { t: Translate; run: TriggerRun; onAction: ActionFn }) {
  const { t, run, onAction } = props
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  function control(action: string, extra?: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    void Promise.resolve(onAction('run.control', { runId: run.id, action, ...(extra ?? {}) }))
      .then((ok) => {
        if (ok) setNote('')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const buttons: ReactNode[] = []
  if (run.status === 'active') {
    buttons.push(
      <Button
        key="pause"
        variant="secondary"
        disabled={busy}
        className="dshx:max-[600px]:flex-1"
        onClick={() => control('pause')}
      >
        {t('pause')}
      </Button>,
    )
  }
  if (run.status === 'paused-budget') {
    buttons.push(
      <Button
        key="extend"
        variant="default"
        disabled={busy}
        className="dshx:max-[600px]:flex-1"
        onClick={() => control('extend')}
      >
        {t('extend')}
      </Button>,
    )
  }
  if (run.status !== 'completed' && run.status !== 'cancelled') {
    buttons.push(
      <Button
        key="cancel"
        variant="ghost"
        disabled={busy}
        className="dshx:max-[600px]:flex-1"
        onClick={() => {
          if (window.confirm(t('confirmCancel'))) control('cancel')
        }}
      >
        {t('cancel')}
      </Button>,
    )
  }

  // Resume keeps one primary action: an optional note rides along when the
  // input has text, so paused runs do not grow a second, near-duplicate
  // button beside the plain one.
  const needsNote = run.status === 'paused-user' || run.status === 'paused-error'
  if (!needsNote && buttons.length === 0) return null
  return (
    <div>
      {needsNote ? (
        <div className="dshx:mt-2.5 dshx:flex dshx:flex-wrap dshx:gap-2">
          <Input
            className="dshx:flex-[1_1_220px] dshx:pointer-coarse:text-base dshx:max-[600px]:basis-full"
            value={note}
            placeholder={t('resumeNotePlaceholder')}
            aria-label={t('resumeNotePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            variant="default"
            disabled={busy}
            onClick={() =>
              control('resume', note.trim().length > 0 ? { message: note.trim() } : undefined)
            }
          >
            {t('resume')}
          </Button>
        </div>
      ) : null}
      {buttons.length > 0 ? (
        <div className="dshx:mt-3 dshx:flex dshx:flex-wrap dshx:gap-2">{buttons}</div>
      ) : null}
    </div>
  )
}

/** One low-frequency drawer. Its contents answer "what happened" or "how
 * is it configured", never "why is it stopped" or "what can I do", so it
 * starts closed while keeping a 44px tap target. */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="dshx:mt-3.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="dshx:inline-flex dshx:min-h-11 dshx:min-w-11 dshx:items-center dshx:gap-1.5 dshx:rounded-md dshx:text-sm dshx:text-fg-secondary dshx:hover:bg-surface-2 dshx:focus-visible:outline-offset-[-2px]"
      >
        {label}
        <Chevron open={open} />
      </button>
      {open ? <div className="dshx:mt-0.5">{children}</div> : null}
    </div>
  )
}

function RunDetails(props: {
  t: Translate
  run: TriggerRun
  deliveries: Delivery[]
  sessionsById: SessionsById
  onAction: ActionFn
  templates: TemplateRecord[]
  binding?: TriggerBinding
}) {
  const { t, run, sessionsById, onAction, binding } = props
  const deliveries = props.deliveries ?? []
  const sent = deliveries.filter((delivery) => delivery.state === 'sent')
  const history = run.history ?? []
  if (history.length === 0 && sent.length === 0 && binding === undefined) return null
  const label = history.length === 0 && sent.length === 0 ? t('configTitle') : t('details')
  return (
    <Disclosure label={label}>
      <HistoryList t={t} run={run} />
      {sent.length > 0 ? (
        <DeliveryList
          t={t}
          title={t('sentDeliveries')}
          run={run}
          sessionsById={sessionsById}
          deliveries={sent}
          onAction={onAction}
        />
      ) : null}
      {binding !== undefined ? (
        <ConfigFacts
          t={t}
          binding={binding}
          sessionsById={sessionsById}
          templates={props.templates}
        />
      ) : null}
    </Disclosure>
  )
}

/** Body of one run, without a second title/status/round header. The row
 * summary already carries those for the current run; other runs supply
 * their own compact header. */
function RunBody(props: {
  t: Translate
  run: TriggerRun
  sessionId: string
  sessionsById: SessionsById
  deliveries: Delivery[]
  onAction: ActionFn
  templates: TemplateRecord[]
  binding?: TriggerBinding
  showConfig: boolean
}) {
  const { t, run, sessionId, sessionsById, deliveries, onAction, templates } = props
  const role = roleOf(run, sessionId)
  const runDeliveries = deliveries.filter((delivery) => delivery.runId === run.id)
  const attention = runDeliveries.filter((delivery) => delivery.state !== 'sent')
  return (
    <div className="dshx:pb-3 dshx:pt-0.5">
      <p className="dshx:mb-0.5 dshx:text-sm dshx:leading-[1.6] dshx:text-fg dshx:[overflow-wrap:anywhere]">
        {runReason(t, run, role)}
      </p>
      {run.pendingSignal ? <p className={HINT_CLASS}>{t('pendingSignalNote')}</p> : null}
      {run.endNote ? <p className={HINT_CLASS}>{t('endNote') + '：' + run.endNote}</p> : null}
      {attention.length > 0 ? (
        <DeliveryList
          t={t}
          title={t('attentionDeliveries')}
          run={run}
          sessionsById={sessionsById}
          deliveries={attention}
          onAction={onAction}
          limit={attention.length}
        />
      ) : null}
      <RunActions t={t} run={run} onAction={onAction} />
      <RunDetails
        t={t}
        run={run}
        sessionsById={sessionsById}
        deliveries={runDeliveries}
        onAction={onAction}
        templates={templates}
        binding={props.showConfig === true ? props.binding : undefined}
      />
    </div>
  )
}

/** A non-current run: compact header, closed until asked for. */
function RunEntry(props: {
  t: Translate
  run: TriggerRun
  sessionId: string
  sessionsById: SessionsById
  deliveries: Delivery[]
  onAction: ActionFn
}) {
  const { t, run, sessionId, sessionsById, deliveries, onAction } = props
  const [open, setOpen] = useState(false)
  const tone = statusTone(run.status)
  const title =
    typeof run.task === 'string' && run.task.trim().length > 0 ? run.task : t('untitledRun')
  const detailId = 'dsh-triggers-run-' + safeId(run.id)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
        className="dshx:flex dshx:w-full dshx:min-h-11 dshx:items-center dshx:gap-2.5 dshx:rounded-md dshx:py-2 dshx:text-left dshx:hover:bg-surface-2 dshx:focus-visible:outline-offset-[-2px]"
      >
        <Chip tone={tone}>{runStateText(t, run)}</Chip>
        <span className="dshx:min-w-0 dshx:flex-1 dshx:truncate dshx:text-sm dshx:font-medium">
          {title}
        </span>
        <span className="dshx:shrink-0 dshx:whitespace-nowrap dshx:text-2xs dshx:text-fg-secondary dshx:max-[600px]:hidden">
          {t('round', { round: run.round, max: run.maxRounds }) + ' · ' + fmtTime(run.startedAt)}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div id={detailId}>
          <RunBody
            t={t}
            run={run}
            sessionId={sessionId}
            sessionsById={sessionsById}
            deliveries={deliveries}
            onAction={onAction}
            templates={[]}
            binding={undefined}
            showConfig={false}
          />
        </div>
      ) : null}
    </div>
  )
}

const ROW_MAIN_CLASS = [
  'dshx:flex dshx:min-w-0 dshx:flex-1 dshx:items-center dshx:gap-3 dshx:py-3 dshx:pl-[18px]',
  'dshx:text-left dshx:hover:bg-surface-2',
  'dshx:focus-visible:outline-offset-[-2px]',
  'dshx:max-[600px]:pl-3.5 dshx:max-[600px]:gap-2.5',
].join(' ')

function TriggerRow(props: {
  t: Translate
  group: RunGroup
  sessionId: string
  sessionsById: SessionsById
  deliveries: Delivery[]
  templates: TemplateRecord[]
  onAction: ActionFn
}) {
  const { t, group, sessionId, sessionsById, deliveries, templates, onAction } = props
  const binding = group.binding
  const current = group.current
  const [expanded, setExpanded] = useState(false)
  const tone = current ? statusTone(current.status) : 'idle'
  const stateText = runStateText(t, current)
  const title = groupTitle(t, group)
  const peerLabel = group.role === 'parent' ? t('peerExecutor') : t('peerReviewer')
  const peer = sessionLabel(t, sessionsById, group.peer)
  const detailId = 'dsh-triggers-detail-' + safeId(group.id)
  const others = current === undefined ? [] : group.runs.filter((run) => run.id !== current.id)
  const bindingPairChanged =
    binding !== undefined &&
    current !== undefined &&
    (binding.executor !== current.executor || binding.parent !== current.parent)

  function toggle() {
    setExpanded(!expanded)
  }

  return (
    <article>
      <div className="dshx:flex dshx:min-h-16 dshx:items-stretch">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={toggle}
          className={ROW_MAIN_CLASS}
        >
          <span
            aria-hidden="true"
            className={cn('dshx:size-[7px] dshx:shrink-0 dshx:rounded-full', TONE_DOT[tone])}
          />
          <span className="dshx:min-w-0 dshx:flex-1">
            <span
              title={title}
              className="dshx:block dshx:truncate dshx:text-base dshx:font-semibold dshx:leading-[1.45]"
            >
              {title}
            </span>
            <span className="dshx:mt-1 dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-1.5 dshx:text-xs dshx:leading-[1.45] dshx:text-fg-secondary">
              {group.role ? (
                <span className="dshx:font-medium dshx:text-fg">
                  {group.role === 'executor' ? t('roleExecutor') : t('roleReviewer')}
                </span>
              ) : null}
              {group.role ? <span className="dshx:opacity-55">·</span> : null}
              {group.role ? <span>{peerLabel + ' ' + peer}</span> : <span>{peer}</span>}
              {current ? <span className="dshx:opacity-55">·</span> : null}
              {current ? (
                <span>{t('round', { round: current.round, max: current.maxRounds })}</span>
              ) : null}
            </span>
          </span>
        </button>
        <span className="dshx:flex dshx:flex-none dshx:items-center dshx:gap-0.5 dshx:pr-2 dshx:max-[600px]:gap-0 dshx:max-[600px]:pr-1">
          <span className={cn(STATE_CLASS, TONE_TEXT[tone])}>{stateText}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={expanded ? t('collapse') : t('expand')}
            onClick={toggle}
          >
            <Chevron open={expanded} />
          </Button>
        </span>
      </div>
      {expanded ? (
        <div
          id={detailId}
          className="dshx:border-t dshx:border-border dshx:bg-bg dshx:pb-[18px] dshx:pl-[37px] dshx:pr-5 dshx:pt-3.5 dshx:max-[600px]:px-4"
        >
          {bindingPairChanged ? <p className={NOTE_CLASS}>{t('snapshotNote')}</p> : null}
          {binding === undefined && current !== undefined ? (
            <p className={cn(NOTE_CLASS, 'dshx:mt-2')}>{t('missingBindingNote')}</p>
          ) : null}
          {current !== undefined ? (
            <RunBody
              t={t}
              run={current}
              sessionId={sessionId}
              sessionsById={sessionsById}
              deliveries={deliveries}
              onAction={onAction}
              templates={templates}
              binding={binding}
              showConfig={true}
            />
          ) : (
            <p className={cn(NOTE_CLASS, 'dshx:mt-2')}>{t('noRunHint')}</p>
          )}
          {current === undefined && binding !== undefined ? (
            <Disclosure label={t('configTitle')}>
              <ConfigFacts
                t={t}
                binding={binding}
                sessionsById={sessionsById}
                templates={templates}
              />
            </Disclosure>
          ) : null}
          {others.length > 0 ? (
            <Disclosure label={t('otherRuns') + ' (' + String(others.length) + ')'}>
              <div className="dshx:flex dshx:flex-col dshx:gap-1">
                {others.map((run) => (
                  <RunEntry
                    key={run.id}
                    t={t}
                    run={run}
                    sessionId={sessionId}
                    sessionsById={sessionsById}
                    deliveries={deliveries}
                    onAction={onAction}
                  />
                ))}
              </div>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

const EMPTY_CLASS =
  'dshx:rounded-[10px] dshx:border dshx:border-border dshx:bg-surface dshx:px-5 dshx:py-9 dshx:text-center'
const LIST_CLASS =
  'dshx:divide-y dshx:divide-border dshx:overflow-hidden dshx:rounded-[10px] dshx:border dshx:border-border dshx:bg-surface'
const BANNER_CLASS = 'dshx:mt-[18px] dshx:flex dshx:items-center dshx:justify-between dshx:gap-3'

function TriggerListView(props: {
  t: Translate
  sessionId: string
  data: StatePayload | null
  loading: boolean
  error?: string
  actionError?: string
  sessionsById: SessionsById
  onAction: ActionFn
  onRefresh: () => void
  onDismissActionError: () => void
}) {
  const { t, sessionId, data, error, actionError } = props
  const loading = props.loading === true
  const sessionsById = props.sessionsById || {}
  const scoped = data === null ? null : scopeSnapshot(data, sessionId)
  const groups = scoped === null ? [] : buildGroups(scoped, sessionId)
  // Captured before the JSX branches: TS narrowing does not survive them.
  const scopedTemplates = scoped === null ? [] : scoped.templates
  const scopedDeliveries = scoped === null ? [] : scoped.deliveries
  const activeCount =
    scoped === null ? 0 : scoped.runs.filter((run) => run.status === 'active').length

  const banner: ReactNode =
    actionError !== undefined ? (
      <Alert variant="error" className={BANNER_CLASS}>
        <span className="dshx:min-w-0 dshx:[overflow-wrap:anywhere]">{actionError}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('close')}
          onClick={props.onDismissActionError}
        >
          ×
        </Button>
      </Alert>
    ) : error !== undefined && data !== null ? (
      <Alert variant="error" className={BANNER_CLASS}>
        <span className="dshx:min-w-0 dshx:[overflow-wrap:anywhere]">{error}</span>
        <Button variant="secondary" size="sm" onClick={props.onRefresh}>
          {t('retry')}
        </Button>
      </Alert>
    ) : null

  let body: ReactNode
  if (sessionId === '') {
    body = (
      <div className={EMPTY_CLASS}>
        <p className="dshx:text-sm dshx:leading-[1.6] dshx:text-fg">{t('noSession')}</p>
      </div>
    )
  } else if (data === null && loading) {
    body = (
      <div className={LIST_CLASS} aria-busy="true" aria-label={t('loading')}>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="dshx:flex dshx:min-h-16 dshx:items-center dshx:gap-3 dshx:px-[18px] dshx:py-4"
          >
            <span className="dshx:size-[7px] dshx:shrink-0 dshx:rounded-full dshx:bg-surface-2" />
            <span className="dshx:min-w-0 dshx:flex-1">
              <span className="dshx:block dshx:h-2.5 dshx:w-[44%] dshx:animate-pulse dshx:rounded-[5px] dshx:bg-surface-2 dshx:motion-reduce:animate-none" />
              <span className="dshx:mt-2 dshx:block dshx:h-2 dshx:w-[68%] dshx:animate-pulse dshx:rounded-[5px] dshx:bg-surface-2 dshx:motion-reduce:animate-none" />
            </span>
          </div>
        ))}
      </div>
    )
  } else if (data === null) {
    body = (
      <div className={EMPTY_CLASS}>
        <p className="dshx:text-sm dshx:leading-[1.6] dshx:text-fg">
          {t('loadFailed', { message: error === undefined ? '' : error })}
        </p>
        <Button variant="secondary" size="sm" className="dshx:mt-3.5" onClick={props.onRefresh}>
          {t('retry')}
        </Button>
      </div>
    )
  } else if (groups.length === 0) {
    body = (
      <div className={EMPTY_CLASS}>
        <p className="dshx:text-sm dshx:leading-[1.6] dshx:text-fg">{t('emptyTitle')}</p>
        <p className="dshx:mt-1.5 dshx:text-xs dshx:leading-[1.6] dshx:text-fg-secondary">
          {t('emptyHint')}
        </p>
      </div>
    )
  } else {
    body = (
      <div className={LIST_CLASS}>
        {groups.map((group) => (
          <TriggerRow
            key={group.id}
            t={t}
            group={group}
            sessionId={sessionId}
            sessionsById={sessionsById}
            templates={scopedTemplates}
            deliveries={scopedDeliveries}
            onAction={props.onAction}
          />
        ))}
      </div>
    )
  }

  // The host's [data-conversation-scroll] is the resident scrollport;
  // this view contributes normal-flow content and must not create a second
  // fixed-height scroll container (that nested overflow is what swallowed
  // wheel input). Chat uses the same ownership model.
  return (
    <div className="dshx:w-full dshx:min-w-0 dshx:bg-bg dshx:text-fg">
      <div className="dshx:mx-auto dshx:w-full dshx:max-w-[820px] dshx:px-6 dshx:pt-10 dshx:pb-[72px] dshx:max-[600px]:px-4 dshx:max-[600px]:pt-7 dshx:max-[600px]:pb-14">
        <header className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-4">
          <div className="dshx:min-w-0">
            <h1 className="dshx:text-[21px] dshx:font-[650] dshx:leading-[1.35] dshx:tracking-[-0.02em] dshx:max-[600px]:text-[19px]">
              {t('title')}
            </h1>
            {activeCount > 0 ? (
              <p className="dshx:mt-1.5 dshx:text-xs dshx:leading-[1.5] dshx:text-fg-secondary">
                {t('activeSummary', { n: activeCount })}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={loading}
            onClick={props.onRefresh}
          >
            <RefreshIcon />
          </Button>
        </header>
        {banner}
        <div className="dshx:mt-[22px]">{body}</div>
      </div>
    </div>
  )
}

interface TriggersViewProps {
  t: Translate
  sessionId?: unknown
  useSessions: (selector: (state: { byId: SessionsById }) => SessionsById) => SessionsById
}

// --- the fetch/poll wrapper; TriggerListView stays pure for tests ---------
function TriggersView(props: TriggersViewProps) {
  const { t } = props
  const sessionId =
    props.sessionId === undefined || props.sessionId === null ? '' : String(props.sessionId)
  const sessionsById = props.useSessions((state) => state.byId)
  const [state, setState] = useState<{
    sessionId: string
    data: StatePayload | null
    loading: boolean
    error?: string
  }>({ sessionId, data: null, loading: true, error: undefined })
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const generation = useRef(0)

  const load = useCallback(() => {
    if (sessionId === '') return Promise.resolve()
    const current = ++generation.current
    return callRpc<StatePayload>('state', { sessionId })
      .then((data) => {
        if (current !== generation.current) return
        setState({ sessionId, data, loading: false, error: undefined })
      })
      .catch((cause: unknown) => {
        if (current !== generation.current) return
        setState((previous) => {
          if (previous.sessionId === sessionId && previous.data !== null) {
            return { sessionId, data: previous.data, loading: false, error: messageOf(cause) }
          }
          return { sessionId, data: null, loading: false, error: messageOf(cause) }
        })
      })
  }, [sessionId])

  useEffect(() => {
    generation.current += 1
    setState({ sessionId, data: null, loading: true, error: undefined })
    setActionError(undefined)
    void load()
    const timer = setInterval(() => {
      if (document.hidden) return
      void load()
    }, POLL_MS)
    const onVisibility = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      generation.current += 1
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load, sessionId])

  const runAction = useCallback(
    (endpoint: string, payload: Record<string, unknown>) => {
      setActionError(undefined)
      return callRpc(endpoint, payload)
        .then(() => load())
        .then(() => true)
        .catch((cause: unknown) => {
          setActionError(template(t('actionFailed'), { message: messageOf(cause) }))
          return false
        })
    },
    [load, t],
  )

  const current =
    state.sessionId === sessionId
      ? state
      : { sessionId, data: null, loading: true, error: undefined }

  return (
    <Root className="dshx:flex-none dshx:w-full dshx:min-w-0 dshx:bg-bg dshx:text-fg">
      <TriggerListView
        t={t}
        sessionId={sessionId}
        data={current.data}
        loading={current.loading}
        error={current.error}
        actionError={actionError}
        sessionsById={sessionsById}
        onAction={runAction}
        onRefresh={() => {
          void load()
        }}
        onDismissActionError={() => {
          setActionError(undefined)
        }}
      />
    </Root>
  )
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-triggers: locale')
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'triggers',
        order: 30,
        locale: LOCALE_NS,
        label: () => t('viewLabel'),
      },
      (props: TriggersViewProps) => <TriggersView {...props} t={t} />,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale']

/** Component/logic handles for the browser-half test harness. */
export const __test = {
  shortId,
  TriggerListView,
  TriggersView,
  TriggerRow,
  RunEntry,
  RunBody,
  RunDetails,
  Disclosure,
  RunActions,
  HistoryList,
  DeliveryList,
  ConfigFacts,
  buildGroups,
  scopeSnapshot,
  canRedeliver,
  zh,
  en,
}
