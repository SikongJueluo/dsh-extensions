/**
 * Storage-domain access: open the trigger domain, seed the built-in
 * templates, and expose small typed helpers over the four tables. The domain
 * is the ONLY persistence — no localStorage, no side JSON files — and every
 * mutation goes through `put`/`update` so durability and `domain/changed`
 * events stay consistent for the UI.
 *
 * Authority note: the `runs` table holds each run's state AND its
 * transactional outbox in one record (one write = one atomic transition);
 * the `deliveries` table is a rebuildable projection of outbox entries kept
 * for UI history and manual-redelivery lookup.
 *
 * @module dsh-triggers/store
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { BUILTIN_TEMPLATE_BODIES } from './prompts.js'
import { TRIGGER_DOMAIN, type BindingRecord, type DeliveryRecord, type RunRecord, type TemplateRecord } from './model.js'

/** The opened trigger domain with its four typed tables. */
export interface TriggerStore {
  readonly domain: Domain<typeof TRIGGER_DOMAIN>
  readonly templates: {
    get(id: string): TemplateRecord | undefined
    entries(): IterableIterator<[string, TemplateRecord]>
    put(id: string, record: TemplateRecord): Promise<void>
    delete(id: string): Promise<boolean>
    readonly size: number
  }
  readonly bindings: {
    get(id: string): BindingRecord | undefined
    entries(): IterableIterator<[string, BindingRecord]>
    put(id: string, record: BindingRecord): Promise<void>
    delete(id: string): Promise<boolean>
    readonly size: number
  }
  readonly runs: {
    get(id: string): RunRecord | undefined
    entries(): IterableIterator<[string, RunRecord]>
    put(id: string, record: RunRecord): Promise<void>
    delete(id: string): Promise<boolean>
    readonly size: number
  }
  readonly deliveries: {
    get(id: string): DeliveryRecord | undefined
    entries(): IterableIterator<[string, DeliveryRecord]>
    put(id: string, record: DeliveryRecord): Promise<void>
    readonly size: number
  }
  close(): Promise<void>
}

/** Open the domain and seed the built-in template rows (idempotent). */
export async function openStore(ctx: Context): Promise<TriggerStore> {
  const domain = await ctx.storageDomain.open(TRIGGER_DOMAIN)
  const templates = domain.table('templates')
  const bindings = domain.table('bindings')
  const runs = domain.table('runs')
  const deliveries = domain.table('deliveries')
  for (const [id, seed] of Object.entries(BUILTIN_TEMPLATE_BODIES)) {
    if (templates.get(id) !== undefined) continue
    const now = Date.now()
    await templates.put(id, { id, name: seed.name, body: seed.body, builtin: true, createdAt: now, updatedAt: now })
  }
  return { domain, templates, bindings, runs, deliveries, close: () => domain.close() }
}
