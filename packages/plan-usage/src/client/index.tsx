// Client half of dsh-plan-usage: a Settings section showing every monitored
// coding plan's quota windows — the rolling five-hour bar, the weekly bar,
// the monthly bar, and (when the plan reports it) the monthly MCP budget —
// each with its consumed percentage and reset countdown. Reads through this
// package's own channel (`/dsh-plan-usage/quota`), refreshes on demand and
// once a minute while visible.
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Progress,
  Root,
  type DshClientContext,
} from '@dsh-extensions/ui'
import './styles.css'

const LOCALE_NS = 'plan-usage'
const RPC_BASE = '/dsh-plan-usage'
const AUTO_REFRESH_MS = 60 * 1000

type Translate = (key: string, params?: Record<string, unknown>) => string

const en = {
  nav: 'Coding Plan Usage',
  title: 'Coding Plan Usage',
  intro:
    'Coding-plan quota windows for every monitored provider, with reset countdowns. Mounted with dsh-auto-continue, quota-limited sessions resume automatically at the reported reset.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  fiveHour: '5-hour window',
  windowOfSize: '{size} window',
  weekly: 'Weekly window',
  monthly: 'Monthly window',
  monthlyMcp: 'Monthly MCP tools',
  resetsIn: 'resets in {duration}',
  resetOverdue: 'reset pending',
  noReset: 'no reset reported',
  consumed: '{percent}% used',
  usedOfTotal: '{used} / {total} used',
  remainingUsd: '{amount} left',
  fetchedAt: 'updated {when}',
  fetchFailed: 'Quota unavailable (see host logs).',
  level: 'plan: {level}',

  // "just now / n s ago / …" — the shared locale keys oauth-providers
  // also uses locally; defined here so the section is self-contained.
  checkedJustNow: 'just now',
  secondsAgo: '{n}s ago',
  minutesAgo: '{n}m ago',
  hoursAgo: '{n}h ago',
}

const zh = {
  nav: 'Coding 套餐用量',
  title: 'Coding 套餐用量',
  intro:
    '所监控各服务商 Coding 套餐的配额窗口与重置倒计时。搭配 dsh-auto-continue 时，限额会话会在重置点自动续跑。',
  refresh: '刷新',
  refreshing: '刷新中…',
  fiveHour: '5 小时窗口',
  windowOfSize: '{size} 窗口',
  weekly: '周窗口',
  monthly: '月度窗口',
  monthlyMcp: '月度 MCP 工具',
  resetsIn: '{duration}后重置',
  resetOverdue: '等待重置生效',
  noReset: '未上报重置时间',
  consumed: '已用 {percent}%',
  usedOfTotal: '已用 {used} / {total}',
  remainingUsd: '剩余 {amount}',
  fetchedAt: '更新于 {when}',
  fetchFailed: '用量暂不可用（详见宿主日志）。',
  level: '套餐：{level}',

  checkedJustNow: '刚刚',
  secondsAgo: '{n} 秒前',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
}

function relTime(t: Translate, at?: number) {
  const diff = Date.now() - (at || 0)
  const s = Math.floor(diff / 1000)
  if (s < 5) return t('checkedJustNow')
  if (s < 60) return t('secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('minutesAgo', { n: m })
  return t('hoursAgo', { n: Math.floor(m / 60) })
}

function fmtDuration(ms: number) {
  if (ms < 0) ms = 0
  let s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (d > 0) return d + 'd ' + h + 'h'
  if (h > 0) return h + 'h ' + m + 'm'
  if (m > 0) return m + 'm ' + s + 's'
  return s + 's'
}

function fmtCount(n: number) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

function fmtUsd(n: number) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  return '$' + n.toFixed(2)
}

interface QuotaWindow {
  percent?: number
  unit?: string
  remaining?: number
  used?: number
  total?: number
  resetAt?: number
  windowMinutes?: number
}

interface QuotaSnapshot {
  level?: string
  fetchedAt?: number
  fiveHour?: QuotaWindow
  weekly?: QuotaWindow
  monthly?: QuotaWindow | null
  monthlyMcp?: QuotaWindow | null
}

interface ProviderView {
  provider: string
  snapshot?: QuotaSnapshot | null
  error?: string
}

interface QuotaResult {
  ok: boolean
  value?: { providers?: ProviderView[] }
  error?: { message?: string }
}

interface Operations {
  quota(refresh: boolean): Promise<QuotaResult>
}

let rpcSeq = 0
function callQuota(refresh: boolean): Promise<QuotaResult> {
  rpcSeq += 1
  return fetch(RPC_BASE + '/quota', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'plan-usage-' + String(rpcSeq),
      method: 'quota',
      payload: { refresh: !!refresh },
    }),
  })
    .then((r) => r.json())
    .then((body: QuotaEnvelope) => {
      if (body && body.result) return body.result
      return { ok: false, error: { message: 'unexpected channel response' } }
    })
}

interface QuotaEnvelope {
  result?: QuotaResult
}

// "5h" / "2.5h" / "45m" from API-reported window minutes, when present.
function fmtWindowSize(minutes: number | undefined) {
  if (!minutes || minutes <= 0) return null
  if (minutes < 60) return minutes + 'm'
  const h = minutes / 60
  return (h === Math.round(h) ? String(Math.round(h)) : h.toFixed(1)) + 'h'
}

function windowLabel(t: Translate, base: string, w: QuotaWindow | undefined | null) {
  const size = w && w.windowMinutes ? fmtWindowSize(w.windowMinutes) : null
  return size ? t('windowOfSize', { size }) : base
}

function resetText(t: Translate, w: QuotaWindow, nowTick: number) {
  if (typeof w.resetAt !== 'number') return t('noReset')
  const remaining = w.resetAt - nowTick
  return remaining > 0 ? t('resetsIn', { duration: fmtDuration(remaining) }) : t('resetOverdue')
}

function progressTone(percent: number | null): 'brand' | 'warn' | 'danger' {
  if (percent !== null && percent >= 100) return 'danger'
  if (percent !== null && percent >= 80) return 'warn'
  return 'brand'
}

function WindowBar({
  t,
  label,
  window: wRaw,
  nowTick,
}: {
  t: Translate
  label: string
  window?: QuotaWindow | null
  nowTick: number
}) {
  const w: QuotaWindow = wRaw ?? {}
  const percent = typeof w.percent === 'number' ? w.percent : null

  let meta: string
  if (percent !== null) {
    // A reported percentage is the primary display; amounts are a fallback for
    // sources that report used/total without a percentage.
    const bits = [t('consumed', { percent })]
    if (w.unit === 'usd' && typeof w.remaining === 'number') {
      bits.push(t('remainingUsd', { amount: fmtUsd(w.remaining) }))
    }
    bits.push(resetText(t, w, nowTick))
    meta = bits.join(' · ')
  } else if (typeof w.used === 'number' && typeof w.total === 'number' && w.total > 0) {
    meta =
      t('usedOfTotal', { used: fmtCount(w.used), total: fmtCount(w.total) }) +
      ' · ' +
      resetText(t, w, nowTick)
  } else {
    const bits: string[] = []
    if (w.unit === 'usd' && typeof w.remaining === 'number') {
      bits.push(t('remainingUsd', { amount: fmtUsd(w.remaining) }))
    }
    if (bits.length > 0 || typeof w.resetAt === 'number') bits.push(resetText(t, w, nowTick))
    meta = bits.length > 0 ? bits.join(' · ') : t('noReset')
  }

  return (
    <div className="dshx:mb-3">
      <div className="dshx:mb-1 dshx:flex dshx:justify-between dshx:gap-3">
        <span className="dshx:text-sm dshx:font-semibold dshx:leading-[20px] dshx:text-fg">
          {label}
        </span>
        <span className="dshx:text-xs dshx:leading-[18px] dshx:text-fg-muted">{meta}</span>
      </div>
      <Progress value={percent} tone={progressTone(percent)} label={label} />
    </div>
  )
}

function ProviderCard({ t, view, nowTick }: { t: Translate; view: ProviderView; nowTick: number }) {
  const snapshot = view.snapshot

  return (
    <Card className="dshx:mb-3.5 dshx:p-3.5">
      <div className="dshx:mb-2.5 dshx:flex dshx:items-baseline dshx:gap-2">
        <h3 className="dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg">
          {view.provider}
        </h3>
        {snapshot && snapshot.level ? (
          <Badge variant="outline">{t('level', { level: snapshot.level })}</Badge>
        ) : null}
        {snapshot ? (
          <span className="dshx:ml-auto dshx:text-xs dshx:leading-[18px] dshx:text-fg-muted">
            {t('fetchedAt', { when: relTime(t, snapshot.fetchedAt) })}
          </span>
        ) : null}
      </div>
      {snapshot ? (
        <>
          <WindowBar
            t={t}
            label={windowLabel(t, t('fiveHour'), snapshot.fiveHour)}
            window={snapshot.fiveHour}
            nowTick={nowTick}
          />
          <WindowBar
            t={t}
            label={windowLabel(t, t('weekly'), snapshot.weekly)}
            window={snapshot.weekly}
            nowTick={nowTick}
          />
          {snapshot.monthly ? (
            <WindowBar t={t} label={t('monthly')} window={snapshot.monthly} nowTick={nowTick} />
          ) : null}
          {snapshot.monthlyMcp ? (
            <WindowBar
              t={t}
              label={t('monthlyMcp')}
              window={snapshot.monthlyMcp}
              nowTick={nowTick}
            />
          ) : null}
        </>
      ) : (
        <Alert variant="warn">{view.error ? view.error : t('fetchFailed')}</Alert>
      )}
    </Card>
  )
}

function Section({ operations, t }: { operations: Operations; t: Translate }) {
  const [views, setViews] = useState<ProviderView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const aliveRef = useRef(true)

  function load(refresh: boolean) {
    if (refresh) setBusy(true)
    return operations
      .quota(refresh)
      .then((result) => {
        // Same throw-on-missing-envelope semantics as the old code: a missing
        // `value` rejects into the catch below and keeps the previous views.
        if (result.ok && aliveRef.current) setViews(result.value!.providers || [])
        return result
      })
      .catch(() => null)
      .then((r) => {
        if (refresh) setBusy(false)
        return r
      })
  }

  useEffect(() => {
    aliveRef.current = true
    void load(false)
    const poll = setInterval(() => {
      if (aliveRef.current) void load(false)
    }, AUTO_REFRESH_MS)
    const tick = setInterval(() => {
      if (aliveRef.current) setNowTick(Date.now())
    }, 1000)
    return () => {
      aliveRef.current = false
      clearInterval(poll)
      clearInterval(tick)
    }
    // Mount/unmount only, like the old code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Root className="dshx:max-w-[min(720px,100vw)] dshx:px-6 dshx:pb-6">
      <h2 className="dshx:mb-1 dshx:text-base dshx:font-semibold dshx:leading-[24px] dshx:text-fg">
        {t('title')}
      </h2>
      <p className="dshx:mb-4 dshx:text-sm dshx:leading-[20px] dshx:text-fg-muted">{t('intro')}</p>
      <div className="dshx:mb-4">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            void load(true)
          }}
        >
          {busy ? t('refreshing') : t('refresh')}
        </Button>
      </div>
      {views === null ? (
        <div className="dshx:text-sm dshx:text-fg-muted">…</div>
      ) : (
        views.map((view) => (
          <ProviderCard key={view.provider} t={t} view={view} nowTick={nowTick} />
        ))
      )}
    </Root>
  )
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-plan-usage: locale')
  const t = ctx.locale.bind(LOCALE_NS)
  const operations: Operations = {
    quota(refresh) {
      return callQuota(refresh)
    },
  }
  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-plan-usage',
        order: 21,
        label: () => t('nav'),
        inject: () => ({ operations, t }),
      },
      Section,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale']
