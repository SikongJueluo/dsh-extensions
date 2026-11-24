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

function AccountRow({ account, t, now }: { account: SnapshotAccount; t: Translate; now: number }) {
  const health = accountHealth(account, now)
  const cooling = cooldownParts(account, now)
  return (
    <li className="dshx:flex dshx:flex-col dshx:gap-0.5">
      <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-sm">
        <span
          aria-hidden="true"
          className={cn('dshx:size-2.5 dshx:shrink-0 dshx:rounded-full', healthDotClass(health))}
        />
        <span className="dshx:sr-only">{healthLabel(t, health)}</span>
        <span className="dshx:min-w-0 dshx:flex-1 dshx:break-all dshx:text-fg-secondary">
          {account.displayName}
        </span>
      </div>
      {cooling === undefined ? null : (
        <span className="dshx:pl-6 dshx:text-2xs dshx:text-warn">
          {cooling.minutes > 0
            ? t('coolingForMinutes', cooling)
            : t('coolingForSeconds', { seconds: cooling.seconds })}
        </span>
      )}
    </li>
  )
}

/** The body of one configured API-key route: what you can select, or why nothing is selectable. */
function RouteBody({
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
  if (!provider.registered) {
    return (
      <div className="dshx:mt-2 dshx:flex dshx:flex-col dshx:items-start dshx:gap-2">
        <Alert variant="error" className="dshx:self-stretch">
          {reasonText(t, provider)}
        </Alert>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    )
  }
  const models = provider.models
  return (
    <>
      {models === undefined ? null : (
        <p className="dshx:mt-1.5 dshx:text-sm dshx:text-fg-secondary">
          {models.effective === 0 ? t('noModels') : t('modelCount', { n: models.effective })}
        </p>
      )}
      {provider.catalogError === undefined ? null : (
        <p className="dshx:mt-0.5 dshx:text-xs dshx:text-fg-muted">{t('catalogDegraded')}</p>
      )}
      {provider.accounts.length === 0 ? null : (
        <ul className="dshx:mt-2 dshx:flex dshx:flex-col dshx:gap-1">
          {provider.accounts.map((account) => (
            <AccountRow key={account.id} account={account} t={t} now={now} />
          ))}
        </ul>
      )}
    </>
  )
}

/** One configured API-key route; a disabled one keeps its name only. */
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
  return (
    <Card className="dshx:px-3.5 dshx:py-3">
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-1.5">
        <CardTitle className="dshx:min-w-0 dshx:break-all">{provider.displayName}</CardTitle>
        {provider.enabled ? null : <Badge variant="danger">{t('routeDisabled')}</Badge>}
      </div>
      {provider.enabled ? (
        <RouteBody provider={provider} t={t} now={now} onRetry={onRetry} />
      ) : null}
    </Card>
  )
}

/** The configured API-key routes as cards, with the section's re-fetch control above them. */
export function SnapshotCards({
  state,
  t,
  now,
  onRetry,
  refetch,
  onRefetch,
}: {
  state: SnapshotState
  t: Translate
  now: number
  onRetry: () => void
  refetch: RefetchState
  onRefetch: () => void
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
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:justify-end dshx:gap-2">
        <Button
          size="md"
          variant="secondary"
          disabled={refetch.status === 'busy'}
          onClick={onRefetch}
        >
          {refetch.status === 'busy' ? (
            <>
              <Spinner label={t('refetching')} />
              {t('refetching')}
            </>
          ) : (
            t('refetchModels')
          )}
        </Button>
      </div>
      {refetch.status !== 'failed' ? null : (
        <p className="dshx:text-xs dshx:text-danger">
          {t('refetchFailed', { detail: shorten(refetch.detail) })}
        </p>
      )}
      <InstanceNotices instances={state.instances} t={t} />
      {routes.length === 0 && !failed ? (
        <p className="dshx:text-sm dshx:text-fg-muted">{t('snapshotEmpty')}</p>
      ) : null}
      {routes.map(({ key, provider }) => (
        <RouteCard key={key} provider={provider} t={t} now={now} onRetry={onRefetch} />
      ))}
    </div>
  )
}

/** The OAuth card's visuals: name, sign-in state (which carries the failure reason), model count. */
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
    <Card className="dshx:px-3.5 dshx:py-3">
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:justify-between dshx:gap-2">
        <CardTitle className="dshx:min-w-0 dshx:break-all">{label}</CardTitle>
        <div className="dshx:flex dshx:items-center dshx:gap-1.5">
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
      <div className="dshx:mt-2 dshx:flex dshx:items-center dshx:gap-2">
        <span
          aria-hidden="true"
          className={cn('dshx:size-2.5 dshx:shrink-0 dshx:rounded-full', dotClass)}
        />
        <span className="dshx:flex-1 dshx:text-sm dshx:text-fg-secondary">
          {statusText(t, status)}
        </span>
      </div>
      {status.kind !== 'ok' || models === undefined ? null : (
        <p className="dshx:mt-1.5 dshx:text-sm dshx:text-fg-secondary">
          {models.effective === 0 ? t('noModels') : t('modelCount', { n: models.effective })}
        </p>
      )}
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

function ProvidersSection({ operations, t }: { operations: Operations; t: Translate }) {
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

  return (
    <Root className="dshx:flex dshx:w-full dshx:max-w-[min(720px,100vw)] dshx:flex-col dshx:px-6 dshx:pb-6 dshx:pt-1">
      <h2 className="dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg">
        {t('title')}
      </h2>
      <div className="dshx:mb-3 dshx:mt-1">
        <SnapshotCards
          state={snapshot}
          t={t}
          now={now}
          refetch={visibleRefetch}
          onRefetch={onRefetch}
          onRetry={() => {
            setSnapshot({ status: 'loading' })
            reload()
          }}
        />
      </div>
      <h3 className="dshx:mb-2 dshx:mt-2 dshx:text-sm dshx:font-semibold dshx:text-fg">
        {t('oauthTitle')}
      </h3>
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
