/** @module dsh-more-providers/keys */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { readFileSync, statSync } from 'node:fs'
import type { AccountPool, PoolAccount } from './providers/pool.js'
import { attemptedAccount } from './providers/pool.js'

/** One provider's key source. */
export type KeySource = { kind: 'file'; path: string } | { kind: 'env'; name: string }

/** Read a key source once, without the service cache. */
export function readKey(source: KeySource): string | undefined {
  if (source.kind === 'env') {
    const value = process.env[source.name]?.trim()
    return value === undefined || value === '' ? undefined : value
  }
  try {
    const value = readFileSync(source.path, 'utf8').trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** One route's pool members, plus the runtime pool when the route registered one. */
export interface RouteAccounts {
  accounts: readonly PoolAccount[]
  pool?: AccountPool
}

/** What `providerKeys.accounts` reports: id, name, a configuration-level key presence and runtime health. */
export interface AccountInfo {
  id: string
  displayName: string
  keyPresent: boolean
  healthy?: boolean
  cooldownUntil?: number
}

/** The `providerKeys` service consumed by dsh-plan-usage. */
export class ProviderKeys extends Service {
  private readonly routes: ReadonlyMap<string, RouteAccounts>
  private readonly cache = new Map<string, { mtimeMs: number; key: string }>()

  constructor(ctx: Context, routes: ReadonlyMap<string, RouteAccounts>) {
    super(ctx, 'providerKeys')
    this.routes = routes
  }

  /** The current key for one route: the attempt's account, else the pool's preferred one. */
  key(provider: string): string | undefined {
    const route = this.routes.get(provider)
    if (route === undefined) return undefined
    const account = attemptedAccount(provider) ?? route.pool?.preferred() ?? route.accounts[0]
    return account === undefined ? undefined : this.read(account.keySource)
  }

  /** The route's pool members in priority order, with configuration and runtime health. */
  accounts(provider: string): readonly AccountInfo[] {
    const route = this.routes.get(provider)
    if (route === undefined) return []
    const snapshot = route.pool?.snapshot().accounts ?? []
    return route.accounts.map((account) => {
      const runtime = snapshot.find((entry) => entry.id === account.id)
      const info: AccountInfo = {
        id: account.id,
        displayName: account.displayName,
        keyPresent: readKey(account.keySource) !== undefined,
      }
      if (runtime !== undefined) info.healthy = runtime.healthy
      if (runtime?.cooldownUntil !== undefined) info.cooldownUntil = runtime.cooldownUntil
      return info
    })
  }

  /** Read one key source, reusing the cached value while the file's mtime is unchanged. */
  private read(source: KeySource): string | undefined {
    if (source.kind === 'env') return readKey(source)
    try {
      const { mtimeMs } = statSync(source.path)
      const cached = this.cache.get(source.path)
      if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.key
      const key = readKey(source)
      if (key === undefined) {
        this.cache.delete(source.path)
        return undefined
      }
      this.cache.set(source.path, { mtimeMs, key })
      return key
    } catch {
      this.cache.delete(source.path)
      return undefined
    }
  }
}
