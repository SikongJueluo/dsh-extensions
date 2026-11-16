/* oxlint-disable react/set-state-in-effect -- the effect mirrors external data into local UI state; deriving it would change render timing */
// Client half of dsh-context-audit: a sidebar panel (like Plugins / Tasks)
// whose main page reports, over the local session event logs:
//
// - per provider/model route: requests, prompt totals, cache-read share and
//   hit rate, output tokens — the numbers cache-affinity A/B needs;
// - per tool: call counts, errored results, failure rate, average and max
//   duration, distinct sessions, and the error-code distribution — the
//   numbers that show which tools (ours or the harness's) misbehave;
// - the heaviest sessions by uncached input.
//
// Reads through this package's own channel (`/dsh-context-audit/report`).
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Root,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type DshClientContext,
} from '@dsh-extensions/ui'
import './styles.css'

const LOCALE_NS = 'context-audit'
const RPC_BASE = '/dsh-context-audit'
const PANEL_ID = 'dsh-context-audit'
const WINDOWS = [7, 14, 30] as const

type Translate = (key: string, params?: Record<string, unknown>) => string

const en = {
  panel: 'Context Audit',
  title: 'Context Audit',
  intro:
    'Cache-hit rates, token usage, and per-tool call/failure statistics over the local session event logs. Nothing leaves this machine.',
  refresh: 'Refresh',
  refreshing: 'Scanning…',
  routes: 'Routes (cache hit = cacheRead / (cacheRead + uncached))',
  tools: 'Tools (failure = isError / completed)',
  sessions: 'Heaviest sessions (by uncached input)',
  colRoute: 'route',
  colRequests: 'reqs',
  colPrompt: 'prompt',
  colCacheRead: 'cache read',
  colHit: 'hit',
  colOutput: 'output',
  colSessions: 'sessions',
  colTool: 'tool',
  colCalls: 'calls',
  colErrors: 'errors',
  colFail: 'fail',
  colAvg: 'avg',
  colMax: 'max',
  colUnfinished: 'no result',
  colSession: 'session',
  colWindow: 'time range',
  colUncached: 'uncached',
  errorCodes: 'error codes:',
  lastDays: '{n}d',
  allHistory: 'all',
  fetchFailed: 'Scan failed: {message}',
  empty: 'No model or tool usage in this window.',
  moreRows: '…and {n} more',
}

const zh = {
  panel: '上下文审计',
  title: '上下文审计',
  intro: '基于本机会话事件日志的缓存命中率、token 用量与各工具调用/失败统计。数据不离开本机。',
  refresh: '刷新',
  refreshing: '扫描中…',
  routes: '路由汇总（命中率 = cacheRead / (cacheRead + uncached输入)）',
  tools: '工具汇总（失败率 = isError / 已完成结果）',
  sessions: '输入量最大的会话（按 uncached 输入）',
  colRoute: '路由',
  colRequests: '请求',
  colPrompt: 'prompt总量',
  colCacheRead: '缓存命中',
  colHit: '命中率',
  colOutput: '输出',
  colSessions: '会话数',
  colTool: '工具',
  colCalls: '调用',
  colErrors: '失败',
  colFail: '失败率',
  colAvg: '平均',
  colMax: '最长',
  colUnfinished: '无结果',
  colSession: '会话',
  colWindow: '时间范围',
  colUncached: 'uncached',
  errorCodes: '错误码分布：',
  lastDays: '{n}天',
  allHistory: '全部',
  fetchFailed: '扫描失败：{message}',
  empty: '窗口内没有模型或工具用量。',
  moreRows: '…还有 {n} 项',
}

/** Render one unknown template parameter as text, never as `[object Object]`. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined || value === null) return ''
  return JSON.stringify(value) ?? ''
}

function template(text: string, vars: Record<string, unknown>) {
  return String(text).replaceAll(/\{(\w+)\}/g, (_, key: string) => asText(vars[key]))
}

function fmtTokens(n: number) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}

function fmtDuration(ms: number) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function fmtClock(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtHit(cacheRead: number, uncached: number) {
  const total = cacheRead + uncached
  return total === 0 ? '—' : `${((cacheRead / total) * 100).toFixed(1)}%`
}

interface ModelRoute {
  provider: string
  model: string
  requests: number
  uncachedInput: number
  cacheRead: number
  output: number
  sessions: number
}

interface ToolStat {
  name: string
  calls: number
  errors: number
  completed: number
  totalDurationMs: number
  maxDurationMs: number
  unfinished: number
  sessions: number
  errorCodes?: Array<[string, number]>
}

interface SessionStat {
  id: string
  title?: string
  first: number
  last: number
  routes?: string[]
  requests: number
  uncachedInput: number
  cacheRead: number
}

interface Report {
  models: ModelRoute[]
  tools: ToolStat[]
  sessions: SessionStat[]
}

interface ReportEnvelope {
  result?: {
    ok: boolean
    value?: Report
    error?: { message?: string }
  }
}

let rpcSeq = 0
function callReport(days: number | undefined): Promise<Report> {
  rpcSeq += 1
  const payload: Record<string, number> = {}
  if (typeof days === 'number') payload.days = days
  return fetch(`${RPC_BASE}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `context-audit-${String(rpcSeq)}`,
      method: 'report',
      payload,
    }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then((envelope: ReportEnvelope) => {
      const result = envelope && envelope.result
      if (!result || result.ok !== true) {
        throw new Error(result?.error?.message || 'bad response')
      }
      return result.value as Report
    })
}

const TH_L = 'dshx:whitespace-nowrap'
const TH_R = 'dshx:whitespace-nowrap dshx:text-right'
const TD_L = 'dshx:whitespace-nowrap'
const TD_R = 'dshx:whitespace-nowrap dshx:text-right'

/** Bordered scroll box matching the old fixed-density table frame. */
function TableBox({ children }: { children: ReactNode }) {
  return (
    <div className="dshx:min-w-[min(560px,90vw)] dshx:rounded-lg dshx:border dshx:border-border">
      {children}
    </div>
  )
}

function RoutesTable({ t, rows }: { t: Translate; rows: ModelRoute[] }) {
  return (
    <TableBox>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={TH_L}>{t('colRoute')}</TableHead>
            <TableHead className={TH_R}>{t('colRequests')}</TableHead>
            <TableHead className={TH_R}>{t('colPrompt')}</TableHead>
            <TableHead className={TH_R}>{t('colCacheRead')}</TableHead>
            <TableHead className={TH_R}>{t('colHit')}</TableHead>
            <TableHead className={TH_R}>{t('colOutput')}</TableHead>
            <TableHead className={TH_R}>{t('colSessions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => (
            <TableRow key={`${m.provider}/${m.model}`}>
              <TableCell className={TD_L}>{`${m.provider}/${m.model}`}</TableCell>
              <TableCell className={TD_R}>{m.requests}</TableCell>
              <TableCell className={TD_R}>{fmtTokens(m.uncachedInput + m.cacheRead)}</TableCell>
              <TableCell className={TD_R}>{fmtTokens(m.cacheRead)}</TableCell>
              <TableCell className={TD_R}>{fmtHit(m.cacheRead, m.uncachedInput)}</TableCell>
              <TableCell className={TD_R}>{fmtTokens(m.output)}</TableCell>
              <TableCell className={TD_R}>{m.sessions}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableBox>
  )
}

function ToolsTable({ t, rows }: { t: Translate; rows: ToolStat[] }) {
  return (
    <TableBox>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={TH_L}>{t('colTool')}</TableHead>
            <TableHead className={TH_R}>{t('colCalls')}</TableHead>
            <TableHead className={TH_R}>{t('colErrors')}</TableHead>
            <TableHead className={TH_R}>{t('colFail')}</TableHead>
            <TableHead className={TH_R}>{t('colAvg')}</TableHead>
            <TableHead className={TH_R}>{t('colMax')}</TableHead>
            <TableHead className={TH_R}>{t('colUnfinished')}</TableHead>
            <TableHead className={TH_R}>{t('colSessions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tool) => (
            <TableRow key={tool.name}>
              <TableCell className={TD_L}>{tool.name}</TableCell>
              <TableCell className={TD_R}>{tool.calls}</TableCell>
              <TableCell className={TD_R}>{tool.errors}</TableCell>
              <TableCell className={TD_R}>
                {tool.completed === 0
                  ? '—'
                  : `${((tool.errors / tool.completed) * 100).toFixed(1)}%`}
              </TableCell>
              <TableCell className={TD_R}>
                {tool.completed === 0 ? '—' : fmtDuration(tool.totalDurationMs / tool.completed)}
              </TableCell>
              <TableCell className={TD_R}>
                {tool.maxDurationMs > 0 ? fmtDuration(tool.maxDurationMs) : '—'}
              </TableCell>
              <TableCell className={TD_R}>{tool.unfinished}</TableCell>
              <TableCell className={TD_R}>{tool.sessions}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableBox>
  )
}

function SessionsTable({ t, rows }: { t: Translate; rows: SessionStat[] }) {
  return (
    <TableBox>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={TH_L}>{t('colSession')}</TableHead>
            <TableHead className={TH_L}>{t('colWindow')}</TableHead>
            <TableHead className={TH_L}>{t('colRoute')}</TableHead>
            <TableHead className={TH_R}>{t('colRequests')}</TableHead>
            <TableHead className={TH_R}>{t('colUncached')}</TableHead>
            <TableHead className={TH_R}>{t('colHit')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.id}>
              <TableCell className={TD_L}>{s.title || s.id.slice(0, 12)}</TableCell>
              <TableCell className={TD_L}>{`${fmtClock(s.first)}→${fmtClock(s.last)}`}</TableCell>
              <TableCell className={TD_L}>{(s.routes || []).slice(0, 2).join(' + ')}</TableCell>
              <TableCell className={TD_R}>{s.requests}</TableCell>
              <TableCell className={TD_R}>{fmtTokens(s.uncachedInput)}</TableCell>
              <TableCell className={TD_R}>{fmtHit(s.cacheRead, s.uncachedInput)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableBox>
  )
}

/** The panel's main page; `t` arrives as a prop from the apply binding. */
function ContextAuditPage({ t }: { t: Translate }) {
  const [days, setDays] = useState<number | undefined>(14)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setBusy(true)
    setError(undefined)
    callReport(days)
      .then((value) => {
        setReport(value)
      })
      .catch((err: unknown) => {
        const withMessage = err as { message?: string } | undefined
        setError(withMessage && withMessage.message ? withMessage.message : String(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }, [days])

  useEffect(load, [load])

  const windowActive = 'dshx:bg-surface-2'

  let body: ReactNode
  if (error !== undefined) {
    body = (
      <div className="dshx:text-sm dshx:text-fg-muted">
        {template(t('fetchFailed'), { message: error })}
      </div>
    )
  } else if (report === null) {
    body = <div className="dshx:text-sm dshx:text-fg-muted">…</div>
  } else if (report.models.length === 0 && report.tools.length === 0) {
    body = <div className="dshx:text-sm dshx:text-fg-muted">{t('empty')}</div>
  } else {
    const withCodes = report.tools
      .filter((tool) => tool.errorCodes !== undefined && tool.errorCodes.length > 0)
      .slice(0, 8)
    body = (
      <>
        {report.models.length > 0 ? (
          <>
            <h3 className="dshx:mb-2 dshx:mt-4 dshx:text-sm dshx:font-semibold dshx:text-fg">
              {t('routes')}
            </h3>
            <RoutesTable t={t} rows={report.models.slice(0, 20)} />
          </>
        ) : null}
        {report.tools.length > 0 ? (
          <>
            <h3 className="dshx:mb-2 dshx:mt-4 dshx:text-sm dshx:font-semibold dshx:text-fg">
              {t('tools')}
            </h3>
            <ToolsTable t={t} rows={report.tools.slice(0, 30)} />
            {withCodes.length > 0 ? (
              <div className="dshx:mt-2 dshx:text-xs">
                <span className="dshx:text-fg-muted">{t('errorCodes')}</span>
                {withCodes.map((tool) => (
                  <Badge key={tool.name} variant="outline" className="dshx:my-0.5 dshx:mr-1.5">
                    {`${tool.name}: ${(tool.errorCodes ?? [])
                      .map((pair) => pair[0] + '×' + pair[1])
                      .join(', ')}`}
                  </Badge>
                ))}
              </div>
            ) : null}
            {report.tools.length > 30 ? (
              <div className="dshx:mt-1 dshx:text-xs dshx:text-fg-muted">
                {template(t('moreRows'), { n: report.tools.length - 30 })}
              </div>
            ) : null}
          </>
        ) : null}
        {report.sessions.length > 0 ? (
          <>
            <h3 className="dshx:mb-2 dshx:mt-4 dshx:text-sm dshx:font-semibold dshx:text-fg">
              {t('sessions')}
            </h3>
            <SessionsTable t={t} rows={report.sessions} />
          </>
        ) : null}
      </>
    )
  }

  return (
    <Root className="dshx:mx-auto dshx:max-w-[min(960px,100vw)] dshx:p-4">
      <h2 className="dshx:mb-1 dshx:text-base dshx:font-semibold dshx:text-fg">{t('title')}</h2>
      <p className="dshx:mb-3 dshx:text-xs dshx:text-fg-muted">{t('intro')}</p>
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
        {WINDOWS.map((w) => (
          <Button
            key={String(w)}
            variant="secondary"
            size="sm"
            className={days === w ? windowActive : undefined}
            onClick={() => setDays(w)}
          >
            {template(t('lastDays'), { n: w })}
          </Button>
        ))}
        <Button
          variant="secondary"
          size="sm"
          className={days === undefined ? windowActive : undefined}
          onClick={() => setDays(undefined)}
        >
          {t('allHistory')}
        </Button>
        <Button variant="secondary" size="sm" onClick={load}>
          {busy ? t('refreshing') : t('refresh')}
        </Button>
      </div>
      <div className="dshx:mt-2">{body}</div>
    </Root>
  )
}

/** The sidebar entry's icon (a small bar chart). */
function ContextAuditIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20v-6" />
      <path d="M10 20V8" />
      <path d="M16 20v-10" />
      <path d="M22 20v-4" />
      <path d="M2 20h22" />
    </svg>
  )
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-context-audit: locale')
  const t = ctx.locale.bind(LOCALE_NS)
  const boundPage = () => <ContextAuditPage t={t} />
  ctx.slots.inject('main', () => {
    // The layout's `main` slot is keyed: it addresses registrations by `key`
    // (the matching sidebar.panellist id), not by `id`.
    return ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
        inject: () => ({}),
      },
      boundPage,
    )
  })
  ctx.slots.inject('sidebar.panellist', () => {
    return ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: LOCALE_NS,
        label: () => t('panel'),
      },
      ContextAuditIcon,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale']
