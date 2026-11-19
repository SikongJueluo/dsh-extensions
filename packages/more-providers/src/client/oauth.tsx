/**
 * OAuth sign-in cards backed by the stable /dsh-oauth-providers channel. Derived from werifu/dsh-oai-oauth (MIT); see THIRD-PARTY-NOTICE.md.
 * @module dsh-more-providers/client/oauth
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Input,
  Root,
  cn,
  type DshClientContext,
} from '@dsh-extensions/ui'
import { isRecord } from '../record.js'

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
  providersLoadFailed: 'Could not load sign-in providers: {detail}',
  providersEmpty: 'No OAuth sign-in providers are registered.',
  retry: 'Retry',
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
  providersLoadFailed: '无法读取登录项：{detail}',
  providersEmpty: '没有已注册的 OAuth 登录项。',
  retry: '重试',
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

/** Runtime check for the channel envelope's `{ ok, ... }` shape. */
function isRpcResult<T>(value: unknown): value is RpcResult<T> {
  return isRecord(value) && typeof value.ok === 'boolean'
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
  if (/no sign-in stored|not signed in|AUTH_MISSING|AUTH_INVALID/iu.test(m))
    return { key: 'statusNotSignedIn' }
  if (/refresh failed|invalid_refresh_token|re-authenticate|sign in again/iu.test(m))
    return { key: 'statusRefreshFailed', params: { detail: shorten(m) } }
  if (/unreachable|ECONNREFUSED|timeout|fetch failed|non-JSON/iu.test(m))
    return { key: 'statusUnreachable', params: { detail: shorten(m) } }
  if (/HTTP \d{3}/u.test(m)) return { key: 'statusHttpError', params: { detail: m } }
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
    .then((response) => response.json())
    .then((body: unknown) => {
      const rpcBody = isRecord(body) ? body : undefined
      const result = rpcBody?.result
      if (result !== undefined && isRpcResult<T>(result)) return result
      return { ok: false, error: { message: 'unexpected channel response' } }
    })
}

interface SectionProps {
  operations: Operations
  t: Translate
}

interface ProviderCardProps extends SectionProps {
  provider: Provider
  refreshProviders: () => Promise<void>
}

/** The channel's provider list, keeping already loaded cards when a refresh fails. */
type ProviderList =
  | { status: 'loading'; providers: Provider[] }
  | { status: 'ready'; providers: Provider[] }
  | { status: 'failed'; providers: Provider[]; detail: string }

function Section({ operations, t }: SectionProps) {
  const [list, setList] = useState<ProviderList>({ status: 'loading', providers: [] })
  const aliveRef = useRef(true)

  const refreshChannelProviders = useCallback(async () => {
    const result = await callRpc<{ providers?: Provider[] }>('providers').catch(
      (error: unknown): RpcResult<{ providers?: Provider[] }> => ({
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    )
    if (!aliveRef.current) return
    setList((current) =>
      result.ok
        ? { status: 'ready', providers: result.value?.providers ?? [] }
        : { status: 'failed', providers: current.providers, detail: result.error?.message ?? '' },
    )
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void refreshChannelProviders()
    return () => {
      aliveRef.current = false
    }
  }, [refreshChannelProviders])

  return (
    <Root className="dshx:flex dshx:max-w-[720px] dshx:flex-col dshx:px-6 dshx:pb-6 dshx:pt-1">
      <h2 className="dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg">
        {t('title')}
      </h2>
      <p className="dshx:mb-4 dshx:mt-1 dshx:text-sm dshx:text-fg-muted">{t('intro')}</p>
      <div className="dshx:flex dshx:flex-col dshx:gap-3.5">
        {list.status === 'failed' ? (
          <Alert variant="error" className="dshx:flex dshx:items-center dshx:gap-2">
            <span className="dshx:flex-1">
              {t('providersLoadFailed', { detail: shorten(list.detail) })}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void refreshChannelProviders()
              }}
            >
              {t('retry')}
            </Button>
          </Alert>
        ) : null}
        {list.status === 'ready' && list.providers.length === 0 ? (
          <p className="dshx:text-sm dshx:text-fg-muted">{t('providersEmpty')}</p>
        ) : null}
        {list.providers.map((provider) => (
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
          return undefined
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
        return undefined
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'yellow',
          key: 'statusCheckError',
          params: { detail: err instanceof Error && err.message ? err.message : String(err) },
        })
      })
  }

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
        return undefined
      })
      .catch((err: unknown) => {
        const c = classify(err instanceof Error && err.message ? err.message : String(err))
        setStatus({ kind: 'error', key: c.key, params: c.params, raw: c.raw })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  function pollSignIn() {
    return callRpc<SignInState>('poll', { provider: id })
      .then((result) => {
        if (!aliveRef.current) return undefined
        if (result.ok) {
          setAuth(result.value ?? null)
          const v = result.value ?? {}
          if (v.running) {
            setTimeout(() => {
              void pollSignIn()
            }, 1200)
            return undefined
          }
          if (v.done && v.done.status === 'authorized') {
            void discover()
            void refreshProviders()
          }
        }
        return undefined
      })
      .catch(() => {
        if (aliveRef.current) {
          setTimeout(() => {
            void pollSignIn()
          }, 2500)
        }
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
        return undefined
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
        return undefined
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
        return undefined
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
        return undefined
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
      <CardTitle className="dshx:mb-2.5">
        {provider.label === '' ? id : (provider.label ?? id)}
      </CardTitle>

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

/** The host remote surface this client half calls (annotated view of `ctx.remote`). */
interface RemoteLike {
  session: { modelCatalog: () => Promise<CatalogResult> }
  llm: {
    discoverModels: (
      ns: string | undefined,
      options: { provider: string },
    ) => Promise<DiscoverResult>
  }
}

/** Runtime check for the generated remote proxy: the injected services exist. */
function isRemoteLike(value: unknown): value is RemoteLike {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    typeof value.session.modelCatalog === 'function' &&
    isRecord(value.llm) &&
    typeof value.llm.discoverModels === 'function'
  )
}

/** Mount the OAuth provider section into this plugin's client half. The locale namespace, section id and channel prefix keep the `dsh-oauth-providers` names the host half and the settings page already address. */
export function registerOAuthSettings(ctx: DshClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-more-providers: oauth locale')
  const t = ctx.locale.bind(LOCALE_NS)
  const operations: Operations = {
    modelCatalog() {
      const remote: unknown = ctx.remote
      if (!isRemoteLike(remote))
        throw new TypeError('dsh-more-providers: remote session service unavailable')
      return remote.session.modelCatalog()
    },
    discoverModels(ns, provider) {
      const remote: unknown = ctx.remote
      if (!isRemoteLike(remote))
        throw new TypeError('dsh-more-providers: remote llm service unavailable')
      return remote.llm.discoverModels(ns, { provider })
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
