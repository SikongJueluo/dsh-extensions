/**
 * The settings page's Providers section: one card per configured route with its display name,
 * selectable model count and serving accounts, plus the OAuth sign-in cards backed by the stable
 * /dsh-oauth-providers channel. The OAuth cards are derived from werifu/dsh-oai-oauth (MIT); see
 * THIRD-PARTY-NOTICE.md.
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
import { en, zh, type Translate } from './messages'
import {
  accountHealth,
  cooldownParts,
  parseSnapshot,
  routesById,
  servingRevision,
  type AccountHealth,
  type SnapshotAccount,
  type SnapshotInstance,
  type SnapshotModels,
  type SnapshotProvider,
} from './snapshot'

const LOCALE_NS = 'oauth-providers'
const RPC_BASE = '/dsh-oauth-providers'
const STATUS_URL = '/dsh-more-providers/providers'
const REFRESH_URL = '/dsh-more-providers/refresh'
const SNAPSHOT_POLL_MS = 10_000

/** The providers snapshot, read fresh for the section and its cards. */
type SnapshotState =
  | { status: 'loading' }
  | { status: 'ready'; instances: SnapshotInstance[]; readAt: number }
  | { status: 'failed'; detail: string }

/** The catalog re-fetch request: idle, in flight, or failed with the reason and the serving revision it was reported against. */
type RefetchState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'failed'; detail: string; appliedKey: string | undefined }

interface OAuthProvider {
  id: string
  label?: string
  signedIn?: boolean
  settingsNs?: string
}

interface SignInState {
  running?: boolean
  done?: { status?: string }
  notice?: { message?: string; url?: string }
  prompt?: { placeholder?: string }
}

interface DiscoverResult {
  ok: boolean
  value?: unknown
  error?: { message?: string }
}

interface Operations {
  discoverModels(ns: string | undefined, provider: string): Promise<DiscoverResult>
}

/** A wire/error message classified into an i18n key (+ params) or raw text. */
interface Classification {
  key?: string
  params?: Record<string, unknown>
  raw?: string
}

/** How one OAuth route is doing: signed in, waiting, or carrying a classified failure. */
export type OAuthCardStatus =
  | { kind: 'ok' }
  | { kind: 'yellow'; key: string; params?: Record<string, unknown>; raw?: string }
  | { kind: 'red'; key?: string; params?: Record<string, unknown>; raw?: string }

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

const KNOWN_REASONS: Record<string, string> = {
  'the model catalog listed no usable models': 'reasonNoCatalog',
  'no account has a usable model catalog': 'reasonNoCatalog',
  'every model was filtered out': 'reasonAllFiltered',
  'no readable key': 'reasonNoKey',
  'every account is disabled': 'reasonAllDisabled',
}

function statusText(t: Translate, status: OAuthCardStatus): string {
  if (status.kind === 'ok') return t('statusOk')
  if (status.key !== undefined) return t(status.key, status.params ?? {})
  return shorten(status.raw ?? '')
}

function reasonText(t: Translate, provider: SnapshotProvider): string {
  const raw = provider.error
  if (raw === undefined) return t('reasonUnknown')
  const known = KNOWN_REASONS[raw]
  return known === undefined ? t('errorReason', { detail: shorten(raw) }) : t(known)
}

/** The dot colour for one account row: usable, cooling, or without a readable key. */
function healthDotClass(health: AccountHealth): string {
  if (health === 'ready') return 'dshx:bg-ok'
  if (health === 'cooling') return 'dshx:bg-warn'
  return 'dshx:bg-danger'
}

function healthLabel(t: Translate, health: AccountHealth): string {
  if (health === 'ready') return t('accountReady')
  if (health === 'cooling') return t('accountCooling')
  return t('accountNotReady')
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

/** Ask the host to re-read every provider's `modelsURL`; a failed discovery rejects with its reason and leaves the previous registration serving. */
async function refetchCatalog(): Promise<void> {
  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.instances)) {
    throw new TypeError('malformed refresh response')
  }
  const failures = payload.instances.flatMap((entry) =>
    isRecord(entry) && entry.ok !== true
      ? [typeof entry.error === 'string' ? entry.error : 'unknown error']
      : [],
  )
  if (failures.length > 0) throw new Error(failures.join('; '))
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

/** Configuration problems of every instance, shown above the route cards. */
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

function AccountRow({
  account,
  t,
  now,
  first,
}: {
  account: SnapshotAccount
  t: Translate
  now: number
  first: boolean
}) {
  const health = accountHealth(account, now)
  const cooling = cooldownParts(account, now)
  const status =
    cooling === undefined
      ? health === 'cooling'
        ? t('accountCooling')
        : health === 'unavailable'
          ? t('accountNotReady')
          : undefined
      : cooling.minutes > 0
        ? t('coolingForMinutes', cooling)
        : t('coolingForSeconds', { seconds: cooling.seconds })
  return (
    <div
      className={cn(
        'dshx:flex dshx:items-center dshx:justify-between dshx:gap-2 dshx:px-2.5 dshx:py-1.5',
        first ? undefined : 'dshx:border-t dshx:border-border',
      )}
    >
      <span className="dshx:flex dshx:min-w-0 dshx:items-center dshx:gap-2">
        <span
          aria-hidden="true"
          className={cn('dshx:size-1.5 dshx:shrink-0 dshx:rounded-full', healthDotClass(health))}
        />
        {status === undefined ? (
          <span className="dshx:sr-only">{healthLabel(t, health)}</span>
        ) : null}
        <span className="dshx:truncate dshx:text-sm dshx:text-fg-secondary">
          {account.displayName}
        </span>
      </span>
      {status === undefined ? null : (
        <Badge variant={health === 'cooling' ? 'warn' : 'danger'}>{status}</Badge>
      )}
    </div>
  )
}

/** One enabled API-key route as a grid card: header badge, optional callout, then the account inset. */
function RouteCard({
  provider,
  t,
  now,
  onRetry,
}: {
  provider: SnapshotProvider
  t: Translate
  now: number
  onRetry: () => void
}) {
  const models = provider.registered ? provider.models : undefined
  return (
    <Card className="dshx:flex dshx:flex-col dshx:gap-2.5 dshx:p-3">
      <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-2">
        <CardTitle
          title={provider.displayName}
          className="dshx:min-w-0 dshx:truncate dshx:text-sm dshx:leading-5"
        >
          {provider.displayName}
        </CardTitle>
        {models === undefined ? null : (
          <Badge variant="neutral" className="dshx:font-mono">
            {t('modelsBadge', { n: models.effective })}
          </Badge>
        )}
      </div>
      {provider.registered ? (
        <>
          {provider.catalogError === undefined ? null : (
            <Alert variant="warn">{t('catalogDegraded')}</Alert>
          )}
          {provider.accounts.length === 0 ? null : (
            <div className="dshx:mt-auto dshx:flex dshx:flex-col dshx:overflow-hidden dshx:rounded-control dshx:border dshx:border-border dshx:bg-bg">
              {provider.accounts.map((account, index) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  t={t}
                  now={now}
                  first={index === 0}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="dshx:flex dshx:flex-1 dshx:flex-col dshx:justify-between dshx:gap-3">
          <Alert variant="error">{reasonText(t, provider)}</Alert>
          <div className="dshx:flex dshx:justify-end">
            <Button size="sm" variant="danger" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

/** One disabled route as a de-emphasised full-width row below the grid. */
function DisabledRow({ provider, t }: { provider: SnapshotProvider; t: Translate }) {
  return (
    <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-3 dshx:rounded-control dshx:border dshx:border-border dshx:bg-surface dshx:px-3 dshx:py-1.5">
      <span className="dshx:flex dshx:min-w-0 dshx:items-center dshx:gap-2">
        <span
          aria-hidden="true"
          className="dshx:size-1.5 dshx:shrink-0 dshx:rounded-full dshx:bg-fg-dimmed"
        />
        <span className="dshx:truncate dshx:text-sm dshx:text-fg-muted">
          {provider.displayName}
        </span>
      </span>
      <Badge variant="outline">{t('routeDisabled')}</Badge>
    </div>
  )
}

/** The header totals: enabled routes, their accounts, and how many routes are disabled. */
function summarize(instances: readonly SnapshotInstance[]): {
  providers: number
  accounts: number
  disabled: number
} {
  let providers = 0
  let accounts = 0
  let disabled = 0
  for (const instance of instances) {
    for (const provider of instance.providers) {
      if (provider.auth !== 'api-key') continue
      if (!provider.enabled) {
        disabled += 1
        continue
      }
      providers += 1
      accounts += provider.accounts.length
    }
  }
  return { providers, accounts, disabled }
}

/** The muted one-line summary under the page subtitle. */
function SummaryStrip({
  summary,
  t,
}: {
  summary: { providers: number; accounts: number; disabled: number }
  t: Translate
}) {
  const separator = (
    <span aria-hidden="true" className="dshx:text-fg-dimmed">
      ·
    </span>
  )
  return (
    <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-x-2.5 dshx:gap-y-1 dshx:text-xs dshx:text-fg-muted">
      <span>{t('summaryProviders', { n: summary.providers })}</span>
      {separator}
      <span>{t('summaryAccounts', { n: summary.accounts })}</span>
      {summary.disabled === 0 ? null : (
        <>
          {separator}
          <span>{t('summaryDisabled', { n: summary.disabled })}</span>
        </>
      )}
    </div>
  )
}

/** The configured API-key routes: enabled ones as cards, disabled ones as de-emphasised rows. */
export function SnapshotCards({
  state,
  t,
  now,
  onRetry,
  refetch,
}: {
  state: SnapshotState
  t: Translate
  now: number
  onRetry: () => void
  refetch: RefetchState
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

  const providers = state.instances.flatMap((instance) =>
    instance.providers
      .filter((provider) => provider.auth === 'api-key')
      .map((provider) => ({ key: `${instance.id}:${provider.route}`, provider })),
  )
  const enabled = providers.filter(({ provider }) => provider.enabled)
  const disabled = providers.filter(({ provider }) => !provider.enabled)
  const failed = state.instances.some((instance) => instance.state !== 'ok')

  return (
    <div className="dshx:flex dshx:flex-col dshx:gap-2">
      {refetch.status !== 'failed' ? null : (
        <p className="dshx:text-xs dshx:text-danger">
          {t('refetchFailed', { detail: shorten(refetch.detail) })}
        </p>
      )}
      <InstanceNotices instances={state.instances} t={t} />
      {providers.length === 0 && !failed ? (
        <p className="dshx:text-sm dshx:text-fg-muted">{t('snapshotEmpty')}</p>
      ) : null}
      {enabled.length === 0 ? null : (
        <div className="dshx:grid dshx:grid-cols-1 dshx:items-stretch dshx:gap-3.5 dshx:sm:grid-cols-2">
          {enabled.map(({ key, provider }) => (
            <RouteCard key={key} provider={provider} t={t} now={now} onRetry={onRetry} />
          ))}
        </div>
      )}
      {disabled.length === 0 ? null : (
        <div className="dshx:mt-0.5 dshx:flex dshx:flex-col dshx:gap-1">
          {disabled.map(({ key, provider }) => (
            <DisabledRow key={key} provider={provider} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The OAuth card's visuals: name with a sign-in badge, the model count, and the sign-in actions. */
export function OAuthCardView({
  provider,
  signedIn,
  status,
  models,
  busy,
  t,
  onSignIn,
  onSignOut,
  onRefresh,
  children,
}: {
  provider: OAuthProvider
  signedIn: boolean
  status: OAuthCardStatus
  models: SnapshotModels | undefined
  busy: boolean
  t: Translate
  onSignIn: () => void
  onSignOut: () => void
  onRefresh: () => void
  children?: ReactNode
}) {
  const dotClass =
    status.kind === 'ok'
      ? 'dshx:bg-ok'
      : status.kind === 'yellow'
        ? 'dshx:bg-warn'
        : 'dshx:bg-danger'
  const label = provider.label === undefined || provider.label === '' ? provider.id : provider.label
  return (
    <Card className="dshx:flex dshx:flex-col dshx:gap-2 dshx:p-3">
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:justify-between dshx:gap-3">
        <div className="dshx:flex dshx:min-w-0 dshx:flex-col dshx:gap-1">
          <div className="dshx:flex dshx:min-w-0 dshx:flex-wrap dshx:items-center dshx:gap-2">
            <CardTitle
              title={label}
              className="dshx:min-w-0 dshx:truncate dshx:text-sm dshx:leading-5"
            >
              {label}
            </CardTitle>
            {status.kind === 'ok' ? (
              <Badge variant="success">
                <span
                  aria-hidden="true"
                  className={cn('dshx:size-1.5 dshx:rounded-full', dotClass)}
                />
                {t('statusOk')}
              </Badge>
            ) : null}
            {status.kind === 'yellow' ? (
              <Badge variant="warn">{statusText(t, status)}</Badge>
            ) : null}
          </div>
          {status.kind === 'red' ? (
            <p className="dshx:flex dshx:items-center dshx:gap-1.5 dshx:text-xs dshx:text-danger">
              <span
                aria-hidden="true"
                className={cn('dshx:size-1.5 dshx:shrink-0 dshx:rounded-full', dotClass)}
              />
              <span>{statusText(t, status)}</span>
            </p>
          ) : null}
          {status.kind !== 'ok' || models === undefined ? null : (
            <p className="dshx:text-xs dshx:text-fg-muted">
              {models.effective === 0 ? t('noModels') : t('modelCount', { n: models.effective })}
            </p>
          )}
        </div>
        <div className="dshx:flex dshx:shrink-0 dshx:items-center dshx:gap-1.5">
          {signedIn ? (
            <Button size="sm" variant="secondary" onClick={onSignOut}>
              {t('signOut')}
            </Button>
          ) : null}
          {signedIn ? (
            <Button size="sm" variant="default" disabled={busy} onClick={onRefresh}>
              {busy ? t('working') : t('refresh')}
            </Button>
          ) : (
            <Button size="sm" variant="default" onClick={onSignIn}>
              {t('signIn')}
            </Button>
          )}
        </div>
      </div>
      {children}
    </Card>
  )
}

interface OAuthCardsProps {
  operations: Operations
  t: Translate
  routes?: ReadonlyMap<string, SnapshotProvider>
  onRouteChanged: () => void
}

/** The channel's provider list, keeping already loaded cards when a refresh fails. */
type OAuthProviderList =
  | { status: 'loading'; providers: OAuthProvider[] }
  | { status: 'ready'; providers: OAuthProvider[] }
  | { status: 'failed'; providers: OAuthProvider[]; detail: string }

/** The OAuth sign-in cards; each also renders its route's sign-in state and model count. */
function OAuthCards({ operations, t, routes, onRouteChanged }: OAuthCardsProps) {
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
    <div className="dshx:flex dshx:flex-col dshx:gap-2">
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
}: {
  provider: OAuthProvider
  operations: Operations
  t: Translate
  refreshProviders: () => Promise<void>
  onRouteChanged: () => void
  snapshot: SnapshotProvider | undefined
}) {
  const id = provider.id
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [auth, setAuth] = useState<SignInState | null>(null)
  const [paste, setPaste] = useState('')
  const aliveRef = useRef(true)

  const signedIn = provider.signedIn === true

  function discover() {
    setBusy(true)
    setActionError(undefined)
    return operations
      .discoverModels(provider.settingsNs, id)
      .then(
        (result) => {
          if (!result.ok) setActionError(result.error?.message ?? 'discovery failed')
          return undefined
        },
        (error: unknown) => {
          setActionError(error instanceof Error ? error.message : asText(error))
          return undefined
        },
      )
      .finally(() => {
        if (!aliveRef.current) return
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
    setActionError(undefined)
    void callRpc('begin', { provider: id }).then(
      (result) => {
        if (result.ok) {
          setAuth({ running: true })
          void pollSignIn()
          return undefined
        }
        setActionError(result.error?.message ?? 'sign-in failed')
        return undefined
      },
      (error: unknown) => {
        setActionError(error instanceof Error ? error.message : asText(error))
        return undefined
      },
    )
  }

  function submitPaste() {
    void callRpc('submit', { provider: id, input: paste }).then(
      () => {
        setPaste('')
        return undefined
      },
      (error: unknown) => {
        setActionError(error instanceof Error ? error.message : asText(error))
        return undefined
      },
    )
  }

  function cancelSignIn() {
    void callRpc('cancel', { provider: id }).then(
      () => {
        setAuth(null)
        return undefined
      },
      () => undefined,
    )
  }

  function signOut() {
    void callRpc('logout', { provider: id }).then(
      () => {
        setAuth(null)
        setActionError(undefined)
        void refreshProviders()
        onRouteChanged()
        return undefined
      },
      (error: unknown) => {
        setActionError(error instanceof Error ? error.message : asText(error))
        return undefined
      },
    )
  }

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const status: OAuthCardStatus =
    actionError !== undefined
      ? { kind: 'red', ...classify(actionError) }
      : !signedIn
        ? { kind: 'yellow', key: 'statusNotSignedIn' }
        : snapshot?.catalogError !== undefined
          ? { kind: 'red', ...classify(snapshot.catalogError) }
          : snapshot?.models === undefined
            ? { kind: 'yellow', key: 'statusUnknown' }
            : { kind: 'ok' }

  const running = !!(auth && auth.running)
  const notice = auth?.notice
  const prompt = auth?.prompt

  return (
    <OAuthCardView
      provider={provider}
      signedIn={signedIn}
      status={status}
      models={snapshot?.models}
      busy={busy}
      t={t}
      onSignIn={startSignIn}
      onSignOut={signOut}
      onRefresh={() => {
        void discover()
      }}
    >
      {running ? (
        <Card className="dshx:mb-3 dshx:mt-2.5 dshx:px-3 dshx:py-2.5">
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
    </OAuthCardView>
  )
}

/** The host remote surface this client half calls (annotated view of `ctx.remote`). */
interface RemoteLike {
  llm: {
    discoverModels: (
      ns: string | undefined,
      options: { provider: string },
    ) => Promise<DiscoverResult>
  }
}

/** Runtime check for the generated remote proxy: the injected services exist. */
function isRemoteLike(value: unknown): value is RemoteLike {
  return isRecord(value) && isRecord(value.llm) && typeof value.llm.discoverModels === 'function'
}

/** The whole section: page copy, the re-fetch control, the API-key cards and the OAuth cards. */
export function ProvidersSection({ operations, t }: { operations: Operations; t: Translate }) {
  const [snapshot, setSnapshot] = useState<SnapshotState>({ status: 'loading' })
  const [refetch, setRefetch] = useState<RefetchState>({ status: 'idle' })
  const aliveRef = useRef(true)

  const reload = useCallback(() => {
    void loadSnapshot(setSnapshot, () => aliveRef.current, t)
  }, [t])

  const appliedKey =
    snapshot.status === 'ready'
      ? snapshot.instances
          .map((instance) => instance.appliedRevision ?? instance.revision)
          .join(',')
      : undefined

  const onRefetch = useCallback(() => {
    setRefetch({ status: 'busy' })
    void refetchCatalog()
      .then(
        () => {
          if (aliveRef.current) setRefetch({ status: 'idle' })
          return undefined
        },
        (error: unknown) => {
          if (!aliveRef.current) return undefined
          setRefetch({
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
            appliedKey,
          })
          return undefined
        },
      )
      .finally(() => {
        if (aliveRef.current) reload()
      })
  }, [appliedKey, reload])

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

  const visibleRefetch: RefetchState =
    refetch.status === 'failed' && refetch.appliedKey !== appliedKey ? { status: 'idle' } : refetch

  const routes = snapshot.status === 'ready' ? routesById(snapshot.instances) : undefined
  const now = snapshot.status === 'ready' ? snapshot.readAt : 0

  const summary = snapshot.status === 'ready' ? summarize(snapshot.instances) : undefined

  return (
    <Root className="dshx:flex dshx:w-full dshx:max-w-[min(720px,100vw)] dshx:flex-col dshx:px-6 dshx:pb-6 dshx:pt-1">
      <header className="dshx:mb-4 dshx:flex dshx:flex-col dshx:gap-2">
        <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-3">
          <h2 className="dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg">
            {t('title')}
          </h2>
          <Button
            size="sm"
            variant="secondary"
            disabled={visibleRefetch.status === 'busy'}
            onClick={onRefetch}
          >
            {visibleRefetch.status === 'busy' ? (
              <>
                <Spinner label={t('refetching')} />
                {t('refetching')}
              </>
            ) : (
              t('refetchModels')
            )}
          </Button>
        </div>
        <p className="dshx:text-sm dshx:leading-[20px] dshx:text-fg-muted">{t('intro')}</p>
        {summary === undefined ? null : <SummaryStrip summary={summary} t={t} />}
      </header>
      <SnapshotCards
        state={snapshot}
        t={t}
        now={now}
        refetch={visibleRefetch}
        onRetry={() => {
          setSnapshot({ status: 'loading' })
          reload()
        }}
      />
      <div aria-hidden="true" className="dshx:my-4 dshx:h-px dshx:bg-border" />
      <h3 className="dshx:text-sm dshx:font-semibold dshx:text-fg">{t('oauthTitle')}</h3>
      <p className="dshx:mb-2 dshx:mt-1 dshx:text-xs dshx:leading-[18px] dshx:text-fg-muted">
        {t('oauthIntro')}
      </p>
      <OAuthCards operations={operations} t={t} routes={routes} onRouteChanged={reload} />
    </Root>
  )
}

/** Mount the Providers section into this plugin's client half. The locale namespace and section id keep the `dsh-oauth-providers` names the host half and the settings page already address. */
export function registerProvidersSettings(ctx: DshClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    'dsh-more-providers: providers locale',
  )
  const t = ctx.locale.bind(LOCALE_NS)
  const operations: Operations = {
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
