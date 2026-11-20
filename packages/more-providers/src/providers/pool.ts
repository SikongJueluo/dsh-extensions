/**
 * The account pool: which account serves a request, which accounts a model needs,
 * session stickiness, and the in-memory cooldowns that move traffic off a bad key.
 * @module dsh-more-providers/providers/pool
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { KeySource } from '../keys.js'
import { classifyFailure } from './failure-class.js'

/** One pool member: its id, display name and key source, in priority order. */
export interface PoolAccount {
  id: string
  displayName: string
  keySource: KeySource
}

/** Which account a request may start on: an optional sticky session, the model, and the accounts tried already. */
export interface PoolScope {
  sessionId?: string
  model: string
  exclude?: readonly string[]
}

/** One account's runtime health, as the settings page shows it. */
export interface PoolSnapshotAccount {
  id: string
  displayName: string
  healthy: boolean
  cooldownUntil?: number
}

/** The pool's read-only state; computed fresh on every call. */
export interface PoolSnapshot {
  route: string
  accounts: readonly PoolSnapshotAccount[]
}

/** The account one stream attempt runs under; read by `providerKeys.key` while that attempt streams. */
export interface AttemptContext {
  route: string
  account: PoolAccount
}

const attemptStore = new AsyncLocalStorage<AttemptContext>()

const BASE_COOLDOWN_MS = 5 * 60 * 1000
const MAX_COOLDOWN_MS = 60 * 60 * 1000
const MAX_STICKY_SESSIONS = 1024

interface AccountState {
  failures: number
  cooldownUntil?: number
}

/** The account of the stream attempt the current async context belongs to, if any. */
export function attemptedAccount(route: string): PoolAccount | undefined {
  const context = attemptStore.getStore()
  return context?.route === route ? context.account : undefined
}

/** Run one attempt under `account`, so `providerKeys.key` resolves that account's key. */
export function withAttemptAccount<T>(context: AttemptContext, run: () => T): T {
  return attemptStore.run(context, run)
}

/**
 * The pool's runtime state machine. Every field is shared, keyed by account or
 * session rather than by call, so concurrent requests cannot cross accounts.
 */
export class AccountPool {
  private readonly route: string
  private readonly accounts: readonly PoolAccount[]
  private readonly coverage: ReadonlyMap<string, readonly string[]>
  private readonly states = new Map<string, AccountState>()
  private readonly sticky = new Map<string, string>()

  constructor(input: {
    route: string
    accounts: readonly PoolAccount[]
    coverage: ReadonlyMap<string, readonly string[]>
  }) {
    this.route = input.route
    this.accounts = input.accounts
    this.coverage = input.coverage
  }

  /** The member the pool would rather use first, ignoring session and model. */
  preferred(): PoolAccount | undefined {
    const now = Date.now()
    return this.accounts.find((account) => !this.cooling(account.id, now)) ?? this.accounts[0]
  }

  /**
   * The account this request may start on, or undefined when no account serves the model.
   * A sticky session keeps its account while it is healthy; with every account cooling
   * the highest-priority candidate is returned anyway, so the request meets a real error.
   */
  acquire(scope: PoolScope): PoolAccount | undefined {
    const candidates = this.candidatesFor(scope.model).filter(
      (account) => scope.exclude?.includes(account.id) !== true,
    )
    if (candidates.length === 0) return undefined
    const now = Date.now()
    const healthy = candidates.filter((account) => !this.cooling(account.id, now))
    const available = healthy.length > 0 ? healthy : candidates
    if (scope.sessionId !== undefined) {
      const remembered = this.sticky.get(scope.sessionId)
      const bound = available.find((account) => account.id === remembered)
      if (bound !== undefined) return bound
    }
    const [chosen] = available
    if (chosen === undefined) return undefined
    if (scope.sessionId !== undefined) this.remember(scope.sessionId, chosen.id)
    return chosen
  }

  /** Carry the previous generation's cooldowns over for the accounts both pools share. */
  adopt(previous: AccountPool): void {
    for (const [accountId, state] of previous.states) {
      if (this.states.has(accountId)) continue
      if (!this.accounts.some((account) => account.id === accountId)) continue
      this.states.set(accountId, { ...state })
    }
  }

  /** One attempt succeeded: the account counts as healthy again. */
  markSuccess(accountId: string): void {
    this.states.delete(accountId)
  }

  /** One attempt failed: an account-level failure cools the account down, others change nothing. */
  markFailure(accountId: string, failure: LlmFailure): void {
    if (classifyFailure(failure) !== 'account') return
    const state = this.states.get(accountId) ?? { failures: 0 }
    const cooldownMs = this.cooldownFor(state.failures, failure.providerRetryAfterMs)
    state.failures += 1
    state.cooldownUntil = Date.now() + cooldownMs
    this.states.set(accountId, state)
  }

  /** The current health of every member, in priority order. */
  snapshot(): PoolSnapshot {
    const now = Date.now()
    return {
      route: this.route,
      accounts: this.accounts.map((account) => {
        const cooldownUntil = this.states.get(account.id)?.cooldownUntil
        const cooling = cooldownUntil !== undefined && cooldownUntil > now
        return {
          id: account.id,
          displayName: account.displayName,
          healthy: !cooling,
          ...(cooling ? { cooldownUntil } : {}),
        }
      }),
    }
  }

  private cooling(accountId: string, now: number): boolean {
    const cooldownUntil = this.states.get(accountId)?.cooldownUntil
    return cooldownUntil !== undefined && cooldownUntil > now
  }

  /** Accounts that serve `model`, in priority order; a model outside the coverage has none. */
  private candidatesFor(model: string): readonly PoolAccount[] {
    const ids = this.coverage.get(model)
    if (ids === undefined) return []
    const byId = new Map(this.accounts.map((account) => [account.id, account]))
    return ids.flatMap((id) => {
      const account = byId.get(id)
      return account === undefined ? [] : [account]
    })
  }

  private remember(sessionId: string, accountId: string): void {
    this.sticky.delete(sessionId)
    this.sticky.set(sessionId, accountId)
    if (this.sticky.size > MAX_STICKY_SESSIONS) {
      const oldest = this.sticky.keys().next().value
      if (oldest !== undefined) this.sticky.delete(oldest)
    }
  }

  /** Exponential from five minutes to one hour, unless the provider named a delay. */
  private cooldownFor(failures: number, providerRetryAfterMs: number | undefined): number {
    if (
      providerRetryAfterMs !== undefined &&
      Number.isFinite(providerRetryAfterMs) &&
      providerRetryAfterMs > 0
    ) {
      return providerRetryAfterMs
    }
    return Math.min(BASE_COOLDOWN_MS * 2 ** Math.min(failures, 4), MAX_COOLDOWN_MS)
  }
}

/** Carry one generation's runtime health into the next generation's pool for the shared accounts. */
export function adoptPoolHealth(next: AccountPool, previous: AccountPool): void {
  next.adopt(previous)
}
