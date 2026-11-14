/**
 * API-key sources for the provider registry: an explicit file, an agenix-style
 * `secretDir/<name>` file, or an environment variable. The synchronous
 * `ProviderKeys` service is the single reader plan-usage can consume, with an
 * mtime cache so a rotated file is picked up without restarting dsh.
 *
 * @module dsh-more-providers/keys
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { readFileSync, statSync } from 'node:fs'

/** One provider's key source. */
export type KeySource =
  | { kind: 'file'; path: string }
  | { kind: 'env'; name: string }

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

/** The `providerKeys` service consumed by dsh-plan-usage. */
export class ProviderKeys extends Service {
  private readonly sources: ReadonlyMap<string, KeySource>
  private readonly cache = new Map<string, { mtimeMs: number; key: string }>()

  constructor(ctx: Context, sources: ReadonlyMap<string, KeySource>) {
    super(ctx, 'providerKeys')
    this.sources = sources
  }

  /** The current key for one route, or undefined when missing/empty. */
  key(provider: string): string | undefined {
    const source = this.sources.get(provider)
    if (source === undefined) return undefined
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
