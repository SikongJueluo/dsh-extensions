/**
 * The durable data model: templates, bindings (rule groups), runs, and
 * deliveries — plus the zod schemas that guard the storage-domain boundary.
 *
 * Three record kinds, three lifetimes:
 *
 * - {@link TemplateRecord} — a reusable prompt body with `{{variable}}` slots.
 * - {@link BindingRecord} — one rule group: which two sessions form the loop,
 *   which templates it references, and the round budget NEW runs start from.
 *   Edits affect future runs only; an in-flight run keeps its own snapshot.
 * - {@link RunRecord} — one started loop. Snapshots everything it needs
 *   (executor, parent, budget, template BODIES) so binding edits can never
 *   swap targets under a live conversation.
 * - {@link DeliveryRecord} — one queued prompt intent. The `requestId` is
 *   minted once, persisted BEFORE the prompt call, and reused on every retry:
 *   the session controller dedupes an already-queued/logged requestId, which
 *   is the delivery idempotency contract this package relies on.
 *
 * @module dsh-triggers/model
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import { BUILTIN_REVIEW_TEMPLATE, BUILTIN_REWORK_TEMPLATE, BUILTIN_START_TEMPLATE, DOMAIN_NAME } from './identity.js'

/**
 * Bridge over a zod-version skew: the host runs zod 4.6, whose `ZodObject`
 * carries a wider internals type parameter than the `ZodType<V>` that
 * dsh-storage-domain's declaration (authored against zod 4.4) accepts. The
 * runtime objects are one and the same — only the generic positions moved —
 * so this adapter narrows the schema to the expected parameterisation without
 * touching validation behavior.
 */
function triggerTable<K extends string, V>(schema: z.ZodType<V, any, any>): DomainTableSpec<K, V> {
  return domainTable<K, V>(schema as unknown as Parameters<typeof domainTable<K, V>>[0])
}

/** Structured handoff verdicts the model can emit through `trigger_signal`. */
export const SIGNAL_OUTCOMES = ['deliver', 'rework', 'pass', 'needs_user'] as const
export type SignalOutcome = (typeof SIGNAL_OUTCOMES)[number]

/** Whose turn it is inside an active run. */
export type RunPhase = 'awaiting-delivery' | 'awaiting-review'

/** Lifecycle status of a run; `phase` stays meaningful across the pauses. */
export type RunStatus =
  | 'active'
  /** A `needs_user` outcome or a manual pause; the loop waits for the user. */
  | 'paused-user'
  /** Rework requested but the round budget is spent; waits for more budget. */
  | 'paused-budget'
  /** Abnormal stop: failed/cancelled signal turn, delivery failure, restart uncertainty. */
  | 'paused-error'
  | 'completed'
  | 'cancelled'

/** A signal accepted from the tool, waiting for its turn to end. */
export interface PendingSignal {
  readonly outcome: SignalOutcome
  readonly summary: string
  /** The session-log turn the signal belongs to; only its matching `turn/end` commits it. */
  readonly turn: number
  readonly at: number
}

/** The deferred rework a `paused-budget` run holds until the budget grows. */
export interface PendingRework {
  readonly summary: string
  /** The round that was reviewed when the budget ran out. */
  readonly round: number
}

/** One compact history line (bounded; the session logs stay the full record). */
export interface RunHistoryEntry {
  readonly at: number
  readonly kind: 'started' | 'signal' | 'advance' | 'pause' | 'resume' | 'end' | 'note' | 'delivery'
  readonly detail?: string
}

/** Template bodies snapshot at run start, already resolved from the binding. */
export interface RunTemplateBodies {
  readonly start: string
  readonly review: string
  readonly rework: string
}

/** One started loop; see module docs for the snapshot rules. */
export interface RunRecord {
  readonly id: string
  readonly bindingId: string
  /** Free-form task label (the handoff task or a UI-entered one). */
  readonly task: string
  readonly status: RunStatus
  readonly phase: RunPhase
  /** Current round, 1-based. One round = one delivery + its review. */
  readonly round: number
  readonly maxRounds: number
  readonly executor: string
  readonly parent: string
  readonly templates: RunTemplateBodies
  readonly pendingSignal?: PendingSignal
  readonly pendingRework?: PendingRework
  /** Which side a `needs_user` pause came from (resume notes go there). */
  readonly pausedBy?: 'executor' | 'parent'
  readonly startedAt: number
  readonly endedAt?: number
  readonly endNote?: string
  readonly history: readonly RunHistoryEntry[]
}

/** Template ids a binding references (bodies resolved at run start). */
export interface BindingTemplateRefs {
  readonly start: string
  readonly review: string
  readonly rework: string
}

/** One rule group: the two sessions plus the templates and budget future runs use. */
export interface BindingRecord {
  readonly id: string
  readonly name: string
  readonly executor: string
  readonly parent: string
  readonly maxRounds: number
  readonly enabled: boolean
  readonly templates: BindingTemplateRefs
  readonly createdAt: number
  readonly updatedAt: number
}

/** A reusable prompt body. Seeded rows carry `builtin: true` and survive deletes. */
export interface TemplateRecord {
  readonly id: string
  readonly name: string
  readonly body: string
  readonly builtin?: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export type DeliveryKind = 'start' | 'review' | 'rework' | 'notice' | 'resume'

/** One queued prompt intent with its idempotency key. */
export interface DeliveryRecord {
  readonly id: string
  readonly runId: string
  readonly round: number
  readonly to: string
  readonly kind: DeliveryKind
  /** Session-controller prompt requestId; minted once, reused on every retry. */
  readonly requestId: string
  readonly state: 'pending' | 'sent' | 'failed'
  readonly content: string
  readonly createdAt: number
  readonly sentAt?: number
  readonly error?: string
}

// ── zod boundary schemas ─────────────────────────────────────────────────────

const schemaSignalOutcome = z.enum(SIGNAL_OUTCOMES)
const schemaRunStatus = z.enum(['active', 'paused-user', 'paused-budget', 'paused-error', 'completed', 'cancelled'])
const schemaRunPhase = z.enum(['awaiting-delivery', 'awaiting-review'])

const schemaPendingSignal = z.object({
  outcome: schemaSignalOutcome,
  summary: z.string(),
  turn: z.number().int(),
  at: z.number(),
})

const schemaPendingRework = z.object({
  summary: z.string(),
  round: z.number().int().positive(),
})

const schemaHistoryEntry = z.object({
  at: z.number(),
  kind: z.enum(['started', 'signal', 'advance', 'pause', 'resume', 'end', 'note', 'delivery']),
  detail: z.string().optional(),
})

const schemaTemplateBodies = z.object({
  start: z.string(),
  review: z.string(),
  rework: z.string(),
})

const schemaRun = z.object({
  id: z.string().min(1),
  bindingId: z.string().min(1),
  task: z.string(),
  status: schemaRunStatus,
  phase: schemaRunPhase,
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  executor: z.string().min(1),
  parent: z.string().min(1),
  templates: schemaTemplateBodies,
  pendingSignal: schemaPendingSignal.optional(),
  pendingRework: schemaPendingRework.optional(),
  pausedBy: z.enum(['executor', 'parent']).optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  endNote: z.string().optional(),
  history: z.array(schemaHistoryEntry),
})
  .refine(run => run.pendingRework === undefined || run.status === 'paused-budget', {
    message: 'pendingRework only lives on a paused-budget run',
    path: ['pendingRework'],
  })
  .refine(run => run.pendingSignal === undefined || run.status === 'active', {
    message: 'pendingSignal only lives on an active run',
    path: ['pendingSignal'],
  })

const schemaTemplateRefs = z.object({
  start: z.string().min(1),
  review: z.string().min(1),
  rework: z.string().min(1),
})

const schemaBinding = z.object({
  id: z.string().min(1),
  name: z.string(),
  executor: z.string().min(1),
  parent: z.string().min(1),
  maxRounds: z.number().int().min(1).max(50),
  enabled: z.boolean(),
  templates: schemaTemplateRefs,
  createdAt: z.number(),
  updatedAt: z.number(),
})
  .refine(binding => binding.executor !== binding.parent, {
    message: 'executor and parent must be two different sessions',
    path: ['parent'],
  })

const schemaTemplate = z.object({
  id: z.string().min(1),
  name: z.string(),
  body: z.string(),
  builtin: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const schemaDelivery = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  round: z.number().int().positive(),
  to: z.string().min(1),
  kind: z.enum(['start', 'review', 'rework', 'notice', 'resume']),
  requestId: z.string().min(1),
  state: z.enum(['pending', 'sent', 'failed']),
  content: z.string(),
  createdAt: z.number(),
  sentAt: z.number().optional(),
  error: z.string().optional(),
})

/** The storage domain: one small `single`-layout unit (records are few and tiny). */
export const TRIGGER_DOMAIN = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    templates: triggerTable<string, TemplateRecord>(schemaTemplate),
    bindings: triggerTable<string, BindingRecord>(schemaBinding),
    runs: triggerTable<string, RunRecord>(schemaRun),
    deliveries: triggerTable<string, DeliveryRecord>(schemaDelivery),
  },
})

/** Default template refs a new binding gets (the seeded built-ins). */
export function defaultTemplateRefs(): BindingTemplateRefs {
  return { start: BUILTIN_START_TEMPLATE, review: BUILTIN_REVIEW_TEMPLATE, rework: BUILTIN_REWORK_TEMPLATE }
}

/** Default round budget for new bindings and runs. */
export const DEFAULT_MAX_ROUNDS = 5
