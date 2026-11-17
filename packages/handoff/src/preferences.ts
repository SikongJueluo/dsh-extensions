/**
 * The handoff plugin's durable model preference.
 * @module dsh-handoff/preferences
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ModelChoice } from './choice.js'
import { PACKAGE_NAME } from './identity.js'

const PREFERENCE_DOMAIN = 'handoff'
const PREFERENCE_TABLE = 'preferences'
const RECORD_VERSION = 1
const DEFAULT_PROFILE_KEY = 'default'

const schemaRecord = z.object({
  version: z.literal(RECORD_VERSION),
  choice: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inherit') }),
    z.object({ kind: z.literal('default') }),
    z.object({
      kind: z.literal('model'),
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.string().min(1).optional(),
    }),
  ]),
  updatedAt: z.number(),
})

/** One stored preference row. */
type PreferenceRecord = z.infer<typeof schemaRecord>

const HANDOFF_DOMAIN = defineDomain({
  name: PREFERENCE_DOMAIN,
  version: RECORD_VERSION,
  tables: {
    preferences: domainTable<string, PreferenceRecord>(schemaRecord),
  },
})

/** The table key isolating one profile. `storageDomain` routes by domain name, but several profiles may share one JSON root, so the profile name belongs in the record key. Characters outside the backend's key grammar are folded to underscores; running without a profile uses a stable fallback key. */
function preferenceKey(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = environment.DSH_PROFILE?.trim() ?? ''
  const base = raw.length > 0 ? raw : DEFAULT_PROFILE_KEY
  return base.replaceAll(/[^A-Za-z0-9_-]/gu, '_').slice(0, 64) || DEFAULT_PROFILE_KEY
}

/** The small surface the command and spawn paths consume. */
export interface PreferenceStore {
  /** The remembered choice, or `undefined` before the first successful handoff. */
  read(): Promise<ModelChoice | undefined>
  /**
   * Persist the choice for the next handoff.
   * @returns `false` when the composition has no storage domain (nothing was written and nothing failed); rejects when a write was attempted and failed.
   */
  write(choice: ModelChoice): Promise<boolean>
  /** Release the domain handle if this store opened it. */
  close(): Promise<void>
}

interface OpenedDomain {
  readonly domain: Domain<typeof HANDOFF_DOMAIN>
  readonly owned: boolean
}

/** Open the preference store lazily: a composition without `storageDomain` must still load the plugin (preferences then simply are not remembered), and a broken backend must only cost the preference, never the handoff. */
export function createPreferenceStore(ctx: Context): PreferenceStore {
  const key = preferenceKey()
  let opening: Promise<OpenedDomain | undefined> | undefined

  const open = async (): Promise<OpenedDomain | undefined> => {
    const facility = ctx.get('storageDomain')
    if (facility === undefined) return undefined
    const existing = facility.get(PREFERENCE_DOMAIN)
    if (existing !== undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A24: DomainFacility.get is the SDK's untyped diagnostic surface by design (only open is typed, and it rejects an already-open domain on hot reload), so the reuse path has no typed handle.
      return { domain: existing as unknown as Domain<typeof HANDOFF_DOMAIN>, owned: false }
    }
    return { domain: await facility.open(HANDOFF_DOMAIN), owned: true }
  }

  const ensure = (): Promise<OpenedDomain | undefined> => {
    opening ??= open().catch((error: unknown) => {
      ctx
        .logger(PACKAGE_NAME)
        .warn('handoff preference domain unavailable; continuing without remembered model', {
          error: String(error),
        })
      opening = undefined
      return undefined
    })
    return opening
  }

  return {
    async read(): Promise<ModelChoice | undefined> {
      const store = await ensure()
      if (store === undefined) return undefined
      return store.domain.table(PREFERENCE_TABLE).get(key)?.choice
    },
    async write(choice: ModelChoice): Promise<boolean> {
      if (ctx.get('storageDomain') === undefined) return false
      const store = await ensure()
      if (store === undefined) throw new Error('handoff preference domain could not be opened')
      await store.domain.table(PREFERENCE_TABLE).put(key, {
        version: RECORD_VERSION,
        choice,
        updatedAt: Date.now(),
      })
      return true
    },
    async close(): Promise<void> {
      const store = await opening?.catch(() => undefined)
      if (store?.owned === true) await store.domain.close()
      opening = undefined
    },
  }
}
