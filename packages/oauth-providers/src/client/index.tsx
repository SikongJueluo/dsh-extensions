// Client half of dsh-oauth-providers: a Settings section listing every
// OAuth-authenticated provider this package ships (today: ChatGPT). TypeScript
// TSX on the shared @dsh-extensions/ui components. Registers the
// `settings.section` slot, localizes through the DSH locale service, reads
// provider state through the typed Client Remote wire, and drives each
// provider's sign-in through this package's own channel
// (`/dsh-oauth-providers`): begin → poll the notice/prompt → submit or
// decline — the pi-style "open this link, paste the code if the redirect
// fails" login.
//
// Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Input,
  Root,
  cn,
  type DshClientContext,
} from '@dsh-extensions/ui'
import './styles.css'

const LOCALE_NS = 'oauth-providers'
const RPC_BASE = '/dsh-oauth-providers'

type Translate = (key: string, params?: Record<string, unknown>) => string

const en: Record<string, string> = {
  nav: 'OAuth Providers',
  title: 'OAuth Providers',
  intro: "Use your model subscriptions — sign in with each provider's account, no API keys.",
  statusLoading: 'Checking…',
  statusOk: 'Signed in · checked {when}',
  checkedJustNow: 'just now',
  secondsAgo: '{n}s ago',
  minutesAgo: '{n}m ago',
  hoursAgo: '{n}h ago',
  statusUnknown: 'Not registered or unavailable.',
  statusNotSignedIn: 'Not signed in — click "Sign in".',
  statusRefreshFailed: 'Token refresh failed: {detail} — sign in again.',
  statusUnreachable: 'Backend unreachable (network/proxy): {detail}',
  statusHttpError: 'Backend error: {detail}',
  statusModelsError: 'Cannot load the model catalog: {detail}',
  statusCheckError: 'Status check failed: {detail}',
  refresh: 'Refresh',
  signIn: 'Sign in',
  signOut: 'Sign out',
  openBrowser: 'Open browser',
  working: 'Working…',
  signinTitle: 'Sign in',
  pasteLabel: 'If the browser cannot redirect back, paste the redirected URL or the code here:',
  submit: 'Submit',
  abandon: 'Cancel sign-in',
  signinCancelled: 'Sign-in cancelled.',
  signinFailed: 'Sign-in failed: {detail}',
}

const zh: Record<string, string> = {
  nav: 'OAuth 登录',
  title: 'OAuth 登录',
  intro: '使用你的模型订阅 —— 每个厂商用自己的账号登录，无需 API Key。',
  statusLoading: '检测中…',
  statusOk: '已登录 · 检测于 {when}',
  checkedJustNow: '刚刚',
  secondsAgo: '{n} 秒前',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  statusUnknown: '未注册或不可用。',
  statusNotSignedIn: '未登录 —— 点击「登录」。',
  statusRefreshFailed: '令牌刷新失败：{detail} —— 请重新登录。',
  statusUnreachable: '后端不可达（网络/代理）：{detail}',
  statusHttpError: '后端返回错误：{detail}',
  statusModelsError: '无法读取模型目录：{detail}',
  statusCheckError: '状态检测失败：{detail}',
  refresh: '刷新',
  signIn: '登录',
  signOut: '退出登录',
  openBrowser: '打开浏览器',
  working: '进行中…',
  signinTitle: '登录',
  pasteLabel: '若浏览器无法重定向回本机，请把跳转后的 URL 或授权码粘贴到这里：',
  submit: '提交',
  abandon: '取消登录',
  signinCancelled: '已取消登录。',
  signinFailed: '登录失败：{detail}',
}

interface ModelEntry {
  id: string
  contextWindow?: string
}

interface Provider {
  id: string
  label?: string
  signedIn?: boolean
  settingsNs?: string
}

interface CatalogFailure {
  id: string
  message?: string
}

interface CatalogGroup {
  id: string
  models?: ModelEntry[]
}

interface Catalog {
  groups?: CatalogGroup[]
  failures?: CatalogFailure[]
}

interface CatalogResult {
  ok: boolean
  value?: Catalog
  error?: { message?: string }
}

interface DiscoverResult {
  ok: boolean
  value?: ModelEntry[]
  error?: { message?: string }
}

interface SignInState {
  running?: boolean
  done?: { status?: string }
  notice?: { message?: string; url?: string }
  prompt?: { placeholder?: string }
}

interface Operations {
  modelCatalog(): Promise<CatalogResult>
  discoverModels(ns: string | undefined, provider: string): Promise<DiscoverResult>
}

/** A wire/error message classified into an i18n key (+ params) or raw text. */
interface Classification {
  key?: string
  params?: Record<string, unknown>
  raw?: string
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ok'; checkedAt: number }
  | {
      kind: 'red' | 'error' | 'yellow'
      key?: string
      params?: Record<string, unknown>
      raw?: string
    }

interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

/** Render an unknown error payload as text, never as `[object Object]`. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined || value === null) return ''
  return JSON.stringify(value) ?? ''
}

function classify(message: unknown): Classification {
  const m = asText(message)
  if (/no sign-in stored|not signed in|AUTH_MISSING|AUTH_INVALID/i.test(m))
    return { key: 'statusNotSignedIn' }
  if (/refresh failed|invalid_refresh_token|re-authenticate|sign in again/i.test(m))
    return { key: 'statusRefreshFailed', params: { detail: shorten(m) } }
  if (/unreachable|ECONNREFUSED|timeout|fetch failed|non-JSON/i.test(m))
    return { key: 'statusUnreachable', params: { detail: shorten(m) } }
  if (/HTTP \d{3}/.test(m)) return { key: 'statusHttpError', params: { detail: m } }
  return { raw: m }
}

function shorten(m: unknown): string {
  let s = asText(m)
  const cut = s.indexOf(' — ')
  if (cut > 0) s = s.slice(0, cut)
  return s.length > 140 ? `${s.slice(0, 140)}…` : s
}

function relTime(t: Translate, at: number): string {
  const diff = Date.now() - (at || 0)
  const s = Math.floor(diff / 1000)
  if (s < 5) return t('checkedJustNow')
  if (s < 60) return t('secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('minutesAgo', { n: m })
  return t('hoursAgo', { n: Math.floor(m / 60) })
}

function statusText(t: Translate, status: Status): string {
  if (status.kind === 'loading') return t('statusLoading')
  if (status.kind === 'ok') return t('statusOk', { when: relTime(t, status.checkedAt) })
  if (status.raw) return status.raw
  return t(status.key ?? '', status.params ?? {})
}

let rpcSeq = 0

interface RpcBody<T> {
  result?: RpcResult<T>
}

function callRpc<T>(endpoint: string, payload?: Record<string, unknown>): Promise<RpcResult<T>> {
  rpcSeq += 1
  return fetch(`${RPC_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `oauth-providers-${String(rpcSeq)}`,
      method: endpoint,
      payload: payload ?? {},
    }),
  })
    .then((response) => response.json() as Promise<RpcBody<T>>)
    .then((body) => {
      if (body && body.result) return body.result
      return { ok: false, error: { message: 'unexpected channel response' } }
    })
}

interface SectionProps {
  operations: Operations
  t: Translate
}

interface ProviderCardProps extends SectionProps {
  provider: Provider
  refreshProviders: () => Promise<RpcResult<{ providers?: Provider[] }> | null>
}

function Section({ operations, t }: SectionProps) {
  const [providers, setProviders] = useState<Provider[]>([])
  const aliveRef = useRef(true)

  function refreshChannelProviders() {
    return callRpc<{ providers?: Provider[] }>('providers')
      .then((result) => {
        if (result.ok && aliveRef.current) setProviders(result.value?.providers ?? [])
        return result
      })
      .catch(() => null)
  }

  useEffect(() => {
    aliveRef.current = true
    void refreshChannelProviders()
    return () => {
      aliveRef.current = false
    }
  }, [])

  return (
    <Root className="dshx:flex dshx:max-w-[720px] dshx:flex-col dshx:px-6 dshx:pb-6 dshx:pt-1">
      <h2 className="dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg">
        {t('title')}
      </h2>
      <p className="dshx:mb-4 dshx:mt-1 dshx:text-sm dshx:text-fg-muted">{t('intro')}</p>
      <div className="dshx:flex dshx:flex-col dshx:gap-3.5">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            operations={operations}
            t={t}
            refreshProviders={refreshChannelProviders}
          />
        ))}
      </div>
    </Root>
  )
}

function ProviderCard({ provider, operations, t, refreshProviders }: ProviderCardProps) {
  const id = provider.id
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [models, setModels] = useState<ModelEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [auth, setAuth] = useState<SignInState | null>(null)
  const [paste, setPaste] = useState('')
  const aliveRef = useRef(true)

  // Passive status from the shared catalog: groups carry models, failures carry reasons.
  function checkStatus() {
    setStatus({ kind: 'loading' })
    return operations
      .modelCatalog()
      .then((result) => {
        if (!result.ok) {
          setStatus({
            kind: 'yellow',
            key: 'statusModelsError',
            params: { detail: result.error ? result.error.message : '' },
          })
          return
        }
        const groups = result.value?.groups ?? []
        const failures = result.value?.failures ?? []
        const group = groups.find((candidate) => candidate.id === id)
        const failure = failures.find((candidate) => candidate.id === id)
        if (group) {
          setModels(group.models ?? [])
          setStatus({ kind: 'ok', checkedAt: Date.now() })
        } else if (failure) {
          setModels([])
          const c = classify(failure.message)
          setStatus({ kind: 'red', key: c.key, params: c.params, raw: c.raw })
        } else {
          setModels([])
          setStatus({ kind: 'yellow', key: 'statusUnknown' })
        }
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'yellow',
          key: 'statusCheckError',
          params: { detail: err instanceof Error && err.message ? err.message : String(err) },
        })
      })
  }

  // Active refresh: llm.discoverModels probes the sign-in and force-fetches models.
  function discover() {
    setBusy(true)
    setStatus({ kind: 'loading' })
    return operations
      .discoverModels(provider.settingsNs, id)
      .then((result) => {
        if (result.ok) {
          setModels(result.value ?? [])
          setStatus({ kind: 'ok', checkedAt: Date.now() })
        } else {
          const msg = result.error ? result.error.message : 'discovery failed'
          setModels([])
          const c = classify(msg)
          setStatus({ kind: 'red', key: c.key, params: c.params, raw: c.raw })
        }
      })
      .catch((err: unknown) => {
        const c = classify(err instanceof Error && err.message ? err.message : String(err))
        setStatus({ kind: 'error', key: c.key, params: c.params, raw: c.raw })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  // --- sign-in over the package's shared channel -------------------------

  function pollSignIn() {
    return callRpc<SignInState>('poll', { provider: id })
      .then((result) => {
        if (!aliveRef.current) return
        if (result.ok) {
          setAuth(result.value ?? null)
          const v = result.value ?? {}
          if (v.running) {
            setTimeout(pollSignIn, 1200)
            return
          }
          if (v.done && v.done.status === 'authorized') {
            void discover()
            void refreshProviders()
          }
        }
      })
      .catch(() => {
        if (aliveRef.current) setTimeout(pollSignIn, 2500)
      })
  }

  function startSignIn() {
    setPaste('')
    callRpc('begin', { provider: id })
      .then((result) => {
        if (result.ok) {
          setAuth({ running: true })
          void pollSignIn()
        } else {
          const msg = result.error ? result.error.message : 'sign-in failed'
          const c = classify(msg)
          setStatus({ kind: 'red', key: c.key, params: c.params, raw: c.raw })
        }
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'yellow',
          key: 'statusCheckError',
          params: { detail: err instanceof Error && err.message ? err.message : String(err) },
        })
      })
  }

  function submitPaste() {
    const input = paste
    callRpc('submit', { provider: id, input })
      .then(() => {
        setPaste('')
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'yellow',
          key: 'statusCheckError',
          params: { detail: err instanceof Error && err.message ? err.message : asText(err) },
        })
      })
  }

  function cancelSignIn() {
    callRpc('cancel', { provider: id })
      .then(() => {
        /* poll picks up the settlement */
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'yellow',
          key: 'statusCheckError',
          params: { detail: err instanceof Error && err.message ? err.message : asText(err) },
        })
      })
  }

  function signOut() {
    callRpc('logout', { provider: id })
      .then(() => {
        setModels([])
        setStatus({ kind: 'yellow', key: 'statusNotSignedIn' })
        void refreshProviders()
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'yellow',
          key: 'statusCheckError',
          params: { detail: err instanceof Error && err.message ? err.message : asText(err) },
        })
      })
  }

  useEffect(() => {
    aliveRef.current = true
    void checkStatus()
    return () => {
      aliveRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dotClass =
    status.kind === 'ok'
      ? 'dshx:bg-ok'
      : status.kind === 'red' || status.kind === 'error'
        ? 'dshx:bg-danger'
        : 'dshx:bg-warn'

  const running = !!(auth && auth.running)
  const notice = auth?.notice
  const prompt = auth?.prompt

  const refreshButton = running ? null : (
    <Button
      size="sm"
      variant={provider.signedIn || status.kind === 'ok' ? 'default' : 'secondary'}
      disabled={busy}
      onClick={() => {
        void discover()
      }}
    >
      {busy ? t('working') : t('refresh')}
    </Button>
  )
  let primaryButton: ReactNode
  if (running) {
    primaryButton = (
      <Button size="sm" variant="default" disabled>
        {t('working')}
      </Button>
    )
  } else if (provider.signedIn || status.kind === 'ok') {
    primaryButton = refreshButton
  } else {
    primaryButton = (
      <Button size="sm" variant="default" onClick={startSignIn}>
        {t('signIn')}
      </Button>
    )
  }

  return (
    <Card className="dshx:px-3.5 dshx:py-3">
      <CardTitle className="dshx:mb-2.5">{provider.label || id}</CardTitle>

      <div className="dshx:mb-3 dshx:flex dshx:items-center dshx:gap-2">
        <span className={cn('dshx:size-2.5 dshx:shrink-0 dshx:rounded-full', dotClass)} />
        <span className="dshx:flex-1 dshx:text-sm dshx:text-fg-secondary">
          {statusText(t, status)}
        </span>
        {provider.signedIn ? (
          <Button size="sm" variant="secondary" onClick={signOut}>
            {t('signOut')}
          </Button>
        ) : null}
        {primaryButton === refreshButton ? null : refreshButton}
        {primaryButton}
      </div>

      {running ? (
        <Card className="dshx:mb-3 dshx:px-3 dshx:py-2.5">
          <div className="dshx:mb-1.5 dshx:text-sm dshx:font-semibold dshx:text-fg">
            {t('signinTitle')}
          </div>
          {notice ? (
            <div className="dshx:mb-1.5 dshx:text-sm dshx:text-fg-secondary">
              {notice.message ?? ''}
              {notice.url ? (
                <div className="dshx:mt-1.5 dshx:flex dshx:items-center dshx:gap-2">
                  <a
                    href={notice.url}
                    target="_blank"
                    rel="noreferrer"
                    className="dshx:flex-1 dshx:break-all dshx:text-xs dshx:text-brand"
                  >
                    {notice.url}
                  </a>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      window.open(notice.url, '_blank', 'noopener')
                    }}
                  >
                    {t('openBrowser')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {prompt ? (
            <div className="dshx:mt-1.5 dshx:flex dshx:flex-col dshx:gap-1.5">
              <span className="dshx:text-xs dshx:text-fg-secondary">{t('pasteLabel')}</span>
              <div className="dshx:flex dshx:gap-2">
                <Input
                  type="text"
                  value={paste}
                  placeholder={prompt.placeholder ?? ''}
                  onChange={(event) => setPaste(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitPaste()
                  }}
                />
                <Button size="sm" variant="default" onClick={submitPaste}>
                  {t('submit')}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="dshx:mt-2.5">
            <Button size="sm" variant="secondary" onClick={cancelSignIn}>
              {t('abandon')}
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="dshx:flex dshx:flex-wrap dshx:gap-1.5">
        {models.map((m) => (
          <Badge key={m.id} variant="outline">
            {m.id + (m.contextWindow ? ` · ${m.contextWindow}` : '')}
          </Badge>
        ))}
      </div>
    </Card>
  )
}

function apply(ctx: DshClientContext) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-oauth-providers: locale')
  const t = ctx.locale.bind(LOCALE_NS)
  // Host operations stay in the apply world; the section and its cards only
  // receive these bound callbacks plus the localized string binder.
  const operations: Operations = {
    modelCatalog() {
      return ctx.remote.session.modelCatalog()
    },
    discoverModels(ns, provider) {
      return ctx.remote.llm.discoverModels(ns, { provider })
    },
  }
  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-oauth-providers',
        order: 20,
        label: () => t('nav'),
        inject: () => ({ operations, t }),
      },
      Section,
    )
  })
}

export { apply }
export const inject = ['slots', 'locale', 'remote', 'remote.llm', 'remote.session']
