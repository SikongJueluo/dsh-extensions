/**
 * The settings page's Providers section: the read-only per-route snapshot of `/dsh-more-providers/providers` plus the OAuth sign-in cards backed by the stable /dsh-oauth-providers channel. The OAuth cards are derived from werifu/dsh-oai-oauth (MIT); see THIRD-PARTY-NOTICE.md.
 * @module dsh-more-providers/client/providers
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Input,
  Root,
  Spinner,
  cn,
  type DshClientContext,
} from '@dsh-extensions/ui'
import { isRecord } from '../record.js'
import {
  accountHealth,
  cooldownParts,
  filteredModelIds,
  parseSnapshot,
  preferredAccount,
  routesById,
  servingRevision,
  statsConsistent,
  visibleModels,
  wasReloaded,
  type SnapshotAccount,
  type SnapshotInstance,
  type SnapshotProvider,
} from './snapshot'

const LOCALE_NS = 'oauth-providers'
const RPC_BASE = '/dsh-oauth-providers'
const STATUS_URL = '/dsh-more-providers/providers'
const SNAPSHOT_POLL_MS = 10_000

type Translate = (key: string, params?: Record<string, unknown>) => string

const en: Record<string, string> = {
  nav: 'Providers',
  title: 'Providers',
  intro:
    'API-key routes come from the provider YAML and are read-only; saving the file applies the change automatically. OAuth subscriptions sign in below.',
  snapshotFailed: 'Could not read the provider snapshot: {detail}',
  snapshotInvalid: 'The provider snapshot is malformed.',
  snapshotEmpty: 'This instance configures no API-key provider.',
  instanceInvalid:
    'The configuration file is invalid: {detail} — the previous version is still serving. Fix the file and it reloads automatically.',
  instanceInvalidActive:
    'The configuration file is invalid: {detail} — v{version} is still serving. Fix the file and it reloads automatically.',
  instanceMissing:
    'The configuration file is missing: {file} — saving it applies the new version automatically.',
  servingVersion: 'serving v{n}',
  configVersion: 'config v{n}',
  autoReloaded: 'reloaded automatically',
  statsMismatch: 'Model statistics do not match the catalog (host bug — please report it).',
  routeDisabled: 'disabled',
  routeDormant: 'not registered',
  routeLabel: 'route {route}',
  modelCount: 'catalog {discovered} → effective {effective}',
  noEffectiveModels: 'no effective model right now',
  accountReady: 'ready',
  accountCooling: 'cooling',
  accountNotReady: 'key unreadable',
  coolingForMinutes: '{minutes}m {seconds}s left',
  coolingForSeconds: '{seconds}s left',
  coolingNote: 'requests skip it until it recovers',
  poolSummary: '{count} account(s) · preferred: {name}',
  poolSummaryNone: '{count} account(s) · none available right now',
  catalogFailed: 'Model catalog unavailable: {detail}',
  routeFailed: 'Not registered: {detail}',
  showFiltered: 'Show {n} filtered model(s)',
  hideFiltered: 'Hide {n} filtered model(s)',
  oauthTitle: 'OAuth sign-in',
  oauthIntro: "Use your model subscriptions — sign in with each provider's account, no API keys.",
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
  nav: '供应商',
  title: '供应商',
  intro:
    'API-key 路由来自 provider YAML，只读展示；保存文件即自动生效，无需重启 dsh。OAuth 订阅在下方登录。',
  snapshotFailed: '无法读取 provider 快照：{detail}',
  snapshotInvalid: 'provider 快照格式不可用。',
  snapshotEmpty: '本实例没有配置 API-key provider。',
  instanceInvalid: '配置文件无效：{detail} —— 上一版配置仍在生效；改好保存后会自动重新加载。',
  instanceInvalidActive:
    '配置文件无效：{detail} —— 仍在使用第 {version} 版；改好保存后会自动重新加载。',
  instanceMissing: '配置文件不存在：{file} —— 保存后会自动加载新版本。',
  servingVersion: '生效中：第 {n} 版',
  configVersion: '配置第 {n} 版',
  autoReloaded: '已自动重载',
  statsMismatch: '模型统计与目录不一致（宿主 bug，请报 issue）。',
  routeDisabled: '已禁用',
  routeDormant: '未注册',
  routeLabel: 'route {route}',
  modelCount: '目录 {discovered} → 生效 {effective}',
  noEffectiveModels: '当前没有生效模型',
  accountReady: '可用',
  accountCooling: '冷却中',
  accountNotReady: '密钥不可读',
  coolingForMinutes: '剩余 {minutes} 分 {seconds} 秒',
  coolingForSeconds: '剩余 {seconds} 秒',
  coolingNote: '正在冷却，请求会跳过它',
  poolSummary: '{count} 个账号 · 优先使用 {name}',
  poolSummaryNone: '{count} 个账号 · 当前没有可用账号',
  catalogFailed: '模型目录不可用：{detail}',
  routeFailed: '未注册：{detail}',
  showFiltered: '被过滤的 {n} 个模型',
  hideFiltered: '收起 {n} 个被过滤模型',
  oauthTitle: 'OAuth 登录',
  oauthIntro: '使用你的模型订阅 —— 每个厂商用自己的账号登录，无需 API Key。',
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

interface OAuthProvider {
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

interface ModelEntry {
  id: string
  contextWindow?: string
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

interface OAuthCardProps extends SectionProps {
  provider: OAuthProvider
  refreshProviders: () => Promise<void>
  onRouteChanged: () => void
  snapshot?: SnapshotProvider
  now: number
}

/** The channel's provider list, keeping already loaded cards when a refresh fails. */
type OAuthProviderList =
  | { status: 'loading'; providers: OAuthProvider[] }
  | { status: 'ready'; providers: OAuthProvider[] }
  | { status: 'failed'; providers: OAuthProvider[]; detail: string }

/** The providers snapshot, read fresh for the section and its cards. */
type SnapshotState =
  | { status: 'loading' }
  | { status: 'ready'; instances: SnapshotInstance[]; readAt: number }
  | { status: 'failed'; detail: string }

function ProvidersSection({ operations, t }: SectionProps) {
  const [snapshot, setSnapshot] = useState<SnapshotState>({ status: 'loading' })
  const aliveRef = useRef(true)

  const reload = useCallback(() => {
    void loadSnapshot(setSnapshot, () => aliveRef.current, t)
  }, [t])

  useEffect(() => {
    aliveRef.current = true
    void loadSnapshot(setSnapshot, () => aliveRef.current, t)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, SNAPSHOT_POLL_MS)
    return () => {
      aliveRef.current = false
      clearInterval(timer)
    }
  }, [reload, t])

  const routes = snapshot.status === 'ready' ? routesById(snapshot.instances) : undefined
  const now = snapshot.status === 'ready' ? snapshot.readAt : 0

  return (
    <Root className="dshx:flex dshx:w-full dshx:max-w-[min(720px,100vw)] dshx:flex-col dshx:px-6 dshx:pb-6 dshx:pt-1">
      <h2 className="dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg">
        {t('title')}
      </h2>
      <p className="dshx:mb-4 dshx:mt-1 dshx:text-sm dshx:text-fg-muted">{t('intro')}</p>
      <SnapshotCards
        state={snapshot}
        t={t}
        now={now}
        onRetry={() => {
          setSnapshot({ status: 'loading' })
          reload()
        }}
      />
      <h3 className="dshx:mb-2 dshx:mt-5 dshx:text-sm dshx:font-semibold dshx:text-fg">
        {t('oauthTitle')}
      </h3>
      <p className="dshx:mb-3 dshx:text-sm dshx:text-fg-muted">{t('oauthIntro')}</p>
      <OAuthCards operations={operations} t={t} routes={routes} now={now} onRouteChanged={reload} />
    </Root>
  )
}

/** The file version the snapshot was built from, plus the version still serving an invalid file. */
function ConfigVersionLine({ instance, t }: { instance: SnapshotInstance; t: Translate }) {
  const serving = instance.state === 'invalid' ? servingRevision(instance) : undefined
  return (
    <p className="dshx:text-xs dshx:text-fg-muted">
      {t('configVersion', { n: instance.revision })}
      {wasReloaded(instance.appliedRevision ?? instance.revision) ? ` · ${t('autoReloaded')}` : ''}
      {serving === undefined ? '' : ` · ${t('servingVersion', { n: serving })}`}
    </p>
  )
}

/** One instance's configuration problem, shown above its routes. */
function InstanceNotices({ instances, t }: { instances: SnapshotInstance[]; t: Translate }) {
  const failed = instances.filter((instance) => instance.state !== 'ok')
  return (
    <>
      {failed.map((instance) => {
        const serving = servingRevision(instance)
        return (
          <Alert
            key={instance.id}
            variant={instance.state === 'missing' ? 'warn' : 'error'}
            className="dshx:flex dshx:flex-col dshx:gap-1"
          >
            <span className="dshx:break-words">
              {instance.state === 'missing'
                ? t('instanceMissing', { file: instance.file })
                : serving === undefined
                  ? t('instanceInvalid', { detail: shorten(instance.error ?? '') })
                  : t('instanceInvalidActive', {
                      detail: shorten(instance.error ?? ''),
                      version: serving,
                    })}
            </span>
            {instance.state === 'missing' ? null : (
              <span className="dshx:break-all dshx:text-2xs dshx:opacity-80">{instance.file}</span>
            )}
          </Alert>
        )
      })}
    </>
  )
}

async function readSnapshot(url: string, t: Translate): Promise<SnapshotInstance[]> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const payload: unknown = await response.json()
  const snapshot = parseSnapshot(payload)
  if (snapshot === undefined) throw new TypeError(t('snapshotInvalid'))
  return snapshot.instances
}

/** Publish one snapshot read; `alive` gates the update after the section unmounts. */
function loadSnapshot(
  setState: Dispatch<SetStateAction<SnapshotState>>,
  alive: () => boolean,
  t: Translate,
): Promise<void> {
  return readSnapshot(STATUS_URL, t).then(
    (instances) => {
      if (alive()) setState({ status: 'ready', instances, readAt: Date.now() })
      return undefined
    },
    (error: unknown) => {
      if (alive()) {
        setState({
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      return undefined
    },
  )
}

function SnapshotCards({
  state,
  t,
  now,
  onRetry,
}: {
  state: SnapshotState
  t: Translate
  now: number
  onRetry: () => void
}) {
  if (state.status === 'loading') {
    return (
      <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-sm dshx:text-fg-muted">
        <Spinner label={t('statusLoading')} />
        <span>{t('statusLoading')}</span>
      </div>
    )
  }

  if (state.status === 'failed') {
    return (
      <Alert variant="error" className="dshx:flex dshx:items-center dshx:gap-2">
        <span className="dshx:flex-1">
          {t('snapshotFailed', { detail: shorten(state.detail) })}
        </span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('retry')}
        </Button>
      </Alert>
    )
  }

  const routes = state.instances.flatMap((instance) =>
    instance.providers
      .filter((provider) => provider.auth === 'api-key')
      .map((provider) => ({ key: `${instance.id}:${provider.route}`, provider })),
  )
  const failed = state.instances.some((instance) => instance.state !== 'ok')

  return (
    <div className="dshx:flex dshx:flex-col dshx:gap-3.5">
      {state.instances.map((instance) => (
        <ConfigVersionLine key={instance.id} instance={instance} t={t} />
      ))}
      <InstanceNotices instances={state.instances} t={t} />
      {routes.length === 0 && !failed ? (
        <p className="dshx:text-sm dshx:text-fg-muted">{t('snapshotEmpty')}</p>
      ) : null}
      {routes.map(({ key, provider }) => (
        <RouteCard key={key} provider={provider} t={t} now={now} />
      ))}
    </div>
  )
}

/** The dot colour for one account row: usable, cooling, or without a readable key. */
function healthDotClass(health: 'ready' | 'cooling' | 'unavailable'): string {
  if (health === 'ready') return 'dshx:bg-ok'
  if (health === 'cooling') return 'dshx:bg-warn'
  return 'dshx:bg-danger'
}

/** How many accounts a route has and which one a request would start on. */
function PoolLine({
  accounts,
  t,
  now,
}: {
  accounts: readonly SnapshotAccount[]
  t: Translate
  now: number
}) {
  const preferred = preferredAccount(accounts, now)
  return (
    <p className="dshx:text-xs dshx:text-fg-muted">
      {preferred === undefined
        ? t('poolSummaryNone', { count: accounts.length })
        : t('poolSummary', { count: accounts.length, name: preferred.displayName })}
    </p>
  )
}

/** Route identity and catalog facts, shared by the API-key card and the OAuth provider card. */
function ProviderStats({
  provider,
  t,
  now,
}: {
  provider: SnapshotProvider
  t: Translate
  now: number
}) {
  const [showFiltered, setShowFiltered] = useState(false)
  const models = visibleModels(provider)
  const consistent = models === undefined || statsConsistent(models)
  const filtered = consistent ? filteredModelIds(provider) : []

  return (
    <>
      <div className="dshx:mt-1 dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-x-3 dshx:gap-y-1 dshx:text-xs dshx:text-fg-muted">
        <span className="dshx:break-all">{t('routeLabel', { route: provider.route })}</span>
        {models === undefined || !consistent ? null : (
          <span>
            {t('modelCount', { discovered: models.discovered, effective: models.effective })}
          </span>
        )}
        {models !== undefined && consistent && models.effective === 0 ? (
          <Badge variant="warn">{t('noEffectiveModels')}</Badge>
        ) : null}
      </div>

      {models !== undefined && !consistent ? (
        <Alert variant="warn" className="dshx:mt-2">
          {t('statsMismatch')}
        </Alert>
      ) : null}

      {provider.accounts.length === 0 ? null : (
        <div className="dshx:mt-2 dshx:flex dshx:flex-col dshx:gap-1">
          <PoolLine accounts={provider.accounts} t={t} now={now} />
          <ul className="dshx:flex dshx:flex-col dshx:gap-1">
            {provider.accounts.map((account, index) => {
              const health = accountHealth(account, now)
              const cooling = cooldownParts(account, now)
              return (
                <li key={account.id} className="dshx:flex dshx:flex-col dshx:gap-0.5">
                  <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-sm">
                    <span className="dshx:w-4 dshx:shrink-0 dshx:text-xs dshx:text-fg-muted">
                      {index + 1}
                    </span>
                    <span
                      className={cn(
                        'dshx:size-2.5 dshx:shrink-0 dshx:rounded-full',
                        healthDotClass(health),
                      )}
                    />
                    <span className="dshx:min-w-0 dshx:flex-1 dshx:break-all dshx:text-fg-secondary">
                      {account.displayName}
                    </span>
                    <span className="dshx:shrink-0 dshx:text-xs dshx:text-fg-muted">
                      {health === 'ready'
                        ? t('accountReady')
                        : health === 'cooling'
                          ? t('accountCooling')
                          : t('accountNotReady')}
                    </span>
                  </div>
                  {cooling === undefined ? null : (
                    <span className="dshx:pl-6 dshx:text-2xs dshx:text-warn">
                      {cooling.minutes > 0
                        ? t('coolingForMinutes', cooling)
                        : t('coolingForSeconds', { seconds: cooling.seconds })}
                      {' · '}
                      {t('coolingNote')}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {provider.catalogError === undefined ? null : (
        <Alert variant="warn" className="dshx:mt-2">
          {t('catalogFailed', { detail: shorten(provider.catalogError) })}
        </Alert>
      )}
      {provider.error === undefined ? null : (
        <Alert variant="error" className="dshx:mt-2">
          {t('routeFailed', { detail: shorten(provider.error) })}
        </Alert>
      )}

      {filtered.length === 0 ? null : (
        <div className="dshx:mt-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowFiltered((shown) => !shown)
            }}
          >
            {showFiltered
              ? t('hideFiltered', { n: filtered.length })
              : t('showFiltered', { n: filtered.length })}
          </Button>
          {showFiltered ? (
            <div className="dshx:mt-1.5 dshx:flex dshx:flex-wrap dshx:gap-1.5">
              {filtered.map((id) => (
                <Badge key={id} variant="outline" className="dshx:max-w-full dshx:break-all">
                  {id}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </>
  )
}

function RouteCard({
  provider,
  t,
  now,
}: {
  provider: SnapshotProvider
  t: Translate
  now: number
}) {
  return (
    <Card className="dshx:px-3.5 dshx:py-3">
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-1.5">
        <CardTitle className="dshx:min-w-0 dshx:break-all">{provider.displayName}</CardTitle>
        <Badge variant="outline">{provider.kind}</Badge>
        <Badge variant="outline">{provider.auth}</Badge>
        {provider.enabled ? null : <Badge variant="danger">{t('routeDisabled')}</Badge>}
        {provider.registered ? null : <Badge variant="warn">{t('routeDormant')}</Badge>}
      </div>
      <ProviderStats provider={provider} t={t} now={now} />
    </Card>
  )
}

interface OAuthCardsProps extends SectionProps {
  routes?: ReadonlyMap<string, SnapshotProvider>
  now: number
  onRouteChanged: () => void
}

/** The OAuth sign-in cards; each also renders its route's snapshot facts, so one provider is one card. */
function OAuthCards({ operations, t, routes, now, onRouteChanged }: OAuthCardsProps) {
  const [list, setList] = useState<OAuthProviderList>({ status: 'loading', providers: [] })
  const aliveRef = useRef(true)

  const refreshChannelProviders = useCallback(async () => {
    const result = await callRpc<{ providers?: OAuthProvider[] }>('providers').catch(
      (error: unknown): RpcResult<{ providers?: OAuthProvider[] }> => ({
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
        <OAuthCard
          key={provider.id}
          provider={provider}
          operations={operations}
          t={t}
          refreshProviders={refreshChannelProviders}
          onRouteChanged={onRouteChanged}
          snapshot={routes?.get(provider.id)}
          now={now}
        />
      ))}
    </div>
  )
}

function OAuthCard({
  provider,
  operations,
  t,
  refreshProviders,
  onRouteChanged,
  snapshot,
  now,
}: OAuthCardProps) {
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
        onRouteChanged()
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
        onRouteChanged()
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

      {snapshot === undefined ? null : <ProviderStats provider={snapshot} t={t} now={now} />}

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

/** Mount the Providers section into this plugin's client half. The locale namespace, section id and channel prefix keep the `dsh-oauth-providers` names the host half and the settings page already address. */
export function registerProvidersSettings(ctx: DshClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    'dsh-more-providers: providers locale',
  )
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
      ProvidersSection,
    )
  })
}
