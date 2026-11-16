/**
 * The handoff plugin's durable model preference.
 *
 * The default route a fresh handoff starts on is the one the operator last
 * accepted — across sessions, workspaces, and browsers — because the choice
 * belongs to this plugin, not to the deployment default (`agentDefaultModel`
 * would silently change every new session) or to the browser's local storage
 * (phones and headless clients would not share it).
 *
 * Storage is a `storageDomain` unit keyed by profile: the JSON backend's root
 * is commonly shared by several profiles (`$DSH_HOME/storages`), and a domain
 * name alone does not isolate them. Only the choice is persisted; the review
 * toggle, workspace, and preset stay per-handoff.
 *
 * @module dsh-handoff/preferences
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ModelChoice } from './brief.js'
import { PACKAGE_NAME } from './identity.js'

/** Domain unit name (storage-domain unit names admit no hyphens). */
export const PREFERENCE_DOMAIN = 'handoff'
/** The single table holding one record per profile. */
const PREFERENCE_TABLE = 'preferences'
/** Record format version; bumped only by an incompatible record shape. */
const RECORD_VERSION = 1
/** Key used when the Harness runs without a profile. */
const DEFAULT_PROFILE_KEY = 'default'

/**
 * Records are validated at the durable boundary by zod, the storage-domain
 * idiom. `reasoningEffort` is optional on purpose: an omitted effort means
 * the target model's own default, not a frozen effort.
 */
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

/** The declared domain; the owning package defines it once. */
export const HANDOFF_DOMAIN = defineDomain({
  name: PREFERENCE_DOMAIN,
  version: RECORD_VERSION,
  tables: {
    preferences: domainTable<string, PreferenceRecord>(schemaRecord),
  },
})

/**
 * The table key isolating one profile. `storageDomain` routes by domain name,
 * but several profiles may share one JSON root, so the profile name belongs in
 * the record key. Characters outside the backend's key grammar are folded to
 * underscores; running without a profile uses a stable fallback key.
 */
export function preferenceKey(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = environment.DSH_PROFILE?.trim() ?? ''
  const base = raw.length > 0 ? raw : DEFAULT_PROFILE_KEY
  return base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || DEFAULT_PROFILE_KEY
}

/** The small surface the command and spawn paths consume. */
export interface PreferenceStore {
  /** The remembered choice, or `undefined` before the first successful handoff. */
  read(): Promise<ModelChoice | undefined>
  /**
   * Persist the choice for the next handoff.
   * @returns `false` when the composition has no storage domain (nothing was
   * written and nothing failed); rejects when a write was attempted and failed.
   */
  write(choice: ModelChoice): Promise<boolean>
  /** Release the domain handle if this store opened it. */
  close(): Promise<void>
}

interface OpenedDomain {
  readonly domain: Domain<typeof HANDOFF_DOMAIN>
  /** False when another plugin instance already owns the open domain. */
  readonly owned: boolean
}

/**
 * Open the preference store lazily: a composition without `storageDomain`
 * must still load the plugin (preferences then simply are not remembered), and
 * a broken backend must only cost the preference, never the handoff.
 */
export function createPreferenceStore(ctx: Context): PreferenceStore {
  const key = preferenceKey()
  let opening: Promise<OpenedDomain | undefined> | undefined

  const open = async (): Promise<OpenedDomain | undefined> => {
    const facility = ctx.get('storageDomain')
    if (facility === undefined) return undefined
    // Another handoff instance in this profile may already have the unit open;
    // reuse it instead of failing the open with `already-open`.
    const existing = facility.get(PREFERENCE_DOMAIN)
    if (existing !== undefined) {
      // `get()` types the raw implementation; only the table/close surface is
      // used here, and a domain opened by another instance has the same spec.
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
      // A transient open failure (backend not ready yet) may heal; retry next use.
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
      // No service at all is a supported composition (nothing to remember);
      // a service that cannot open its unit is a real failure the caller
      // surfaces on the origin session.
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
