/**
 * The providers snapshot wire shape and the derivations the settings cards share: the route index,
 * the counts a registered route may show, and the model ids its filter dropped.
 * @module dsh-more-providers/client/snapshot
 */
import { isRecord } from '../record.js'

export interface SnapshotAccount {
  id: string
  displayName: string
  ready: boolean
  healthy?: boolean
  cooldownUntil?: number
}

export interface SnapshotModels {
  discovered: number
  effective: number
  excluded: string[]
  notIncluded: string[]
}

export interface SnapshotProvider {
  route: string
  kind: 'builtin' | 'custom' | 'command-code' | 'chatgpt'
  auth: 'api-key' | 'oauth'
  displayName: string
  enabled: boolean
  registered: boolean
  accounts: SnapshotAccount[]
  models?: SnapshotModels
  catalogError?: string
  error?: string
}

export interface SnapshotInstance {
  id: string
  file: string
  state: 'ok' | 'invalid' | 'missing'
  error?: string
  revision: number
  appliedRevision?: number
  providers: SnapshotProvider[]
}

export interface Snapshot {
  instances: SnapshotInstance[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isSnapshotAccount(value: unknown): value is SnapshotAccount {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.ready === 'boolean' &&
    (value.healthy === undefined || typeof value.healthy === 'boolean') &&
    (value.cooldownUntil === undefined ||
      (typeof value.cooldownUntil === 'number' && Number.isFinite(value.cooldownUntil)))
  )
}

function isSnapshotModels(value: unknown): value is SnapshotModels {
  return (
    isRecord(value) &&
    typeof value.discovered === 'number' &&
    typeof value.effective === 'number' &&
    isStringArray(value.excluded) &&
    isStringArray(value.notIncluded)
  )
}

function isSnapshotProvider(value: unknown): value is SnapshotProvider {
  return (
    isRecord(value) &&
    (value.kind === 'builtin' ||
      value.kind === 'custom' ||
      value.kind === 'command-code' ||
      value.kind === 'chatgpt') &&
    (value.auth === 'api-key' || value.auth === 'oauth') &&
    typeof value.route === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.registered === 'boolean' &&
    Array.isArray(value.accounts) &&
    value.accounts.every(isSnapshotAccount) &&
    (value.models === undefined || isSnapshotModels(value.models)) &&
    (value.catalogError === undefined || typeof value.catalogError === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

function isSnapshotInstance(value: unknown): value is SnapshotInstance {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.file === 'string' &&
    (value.state === 'ok' || value.state === 'invalid' || value.state === 'missing') &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.appliedRevision === undefined ||
      (typeof value.appliedRevision === 'number' && Number.isFinite(value.appliedRevision))) &&
    Array.isArray(value.providers) &&
    value.providers.every(isSnapshotProvider)
  )
}

/** Parse the snapshot body; a malformed one reads as unavailable rather than rendering junk. */
export function parseSnapshot(value: unknown): Snapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.instances)) return undefined
  if (!value.instances.every(isSnapshotInstance)) return undefined
  return { instances: value.instances }
}

/** Index the reported routes by id, keeping the first instance's row for a repeated route. */
export function routesById(instances: readonly SnapshotInstance[]): Map<string, SnapshotProvider> {
  const routes = new Map<string, SnapshotProvider>()
  for (const instance of instances) {
    for (const provider of instance.providers) {
      if (!routes.has(provider.route)) routes.set(provider.route, provider)
    }
  }
  return routes
}

/** The counts to show: an unregistered route reports no catalog at all. */
export function visibleModels(provider: SnapshotProvider): SnapshotModels | undefined {
  return provider.registered ? provider.models : undefined
}

/** Every model id the filter dropped, excluded first; empty without visible counts. */
export function filteredModelIds(provider: SnapshotProvider): string[] {
  const models = visibleModels(provider)
  return models === undefined ? [] : [...models.excluded, ...models.notIncluded]
}

/** The health one account row reports: usable, cooling down, or without a readable key. */
export type AccountHealth = 'ready' | 'cooling' | 'unavailable'

/** Milliseconds of cooldown left, absent when the account is not cooling. */
export function cooldownParts(
  account: SnapshotAccount,
  now: number,
): { minutes: number; seconds: number } | undefined {
  const until = account.cooldownUntil
  if (until === undefined || until <= now) return undefined
  const total = Math.ceil((until - now) / 1000)
  return { minutes: Math.floor(total / 60), seconds: total % 60 }
}

/** One account's row state at `now`; a cooling account is unhealthy until its deadline passes. */
export function accountHealth(account: SnapshotAccount, now: number): AccountHealth {
  if (!account.ready) return 'unavailable'
  if (account.healthy === false || cooldownParts(account, now) !== undefined) return 'cooling'
  return 'ready'
}

/** The account a request would start on: the first ready one that is not cooling. */
export function preferredAccount(
  accounts: readonly SnapshotAccount[],
  now: number,
): SnapshotAccount | undefined {
  return accounts.find((account) => accountHealth(account, now) === 'ready')
}

/** Whether the counts still add up: a mismatch means the host reported broken statistics. */
export function statsConsistent(models: SnapshotModels): boolean {
  return models.discovered === models.effective + models.excluded.length + models.notIncluded.length
}

/** Whether a revision came from a hot reload rather than the initial load. */
export function wasReloaded(revision: number): boolean {
  return revision > 1
}

/** The revision still serving while the file moved on; absent when both name the same revision. */
export function servingRevision(instance: SnapshotInstance): number | undefined {
  const applied = instance.appliedRevision
  if (applied === undefined || applied === instance.revision) return undefined
  return applied
}
