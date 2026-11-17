/**
 * The durable data model: templates, bindings (rule groups), runs, and deliveries - plus the zod schemas that guard the storage-domain boundary.
 * @module dsh-triggers/model
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import {
  BUILTIN_REVIEW_TEMPLATE,
  BUILTIN_REWORK_TEMPLATE,
  BUILTIN_START_TEMPLATE,
  DOMAIN_NAME,
} from './identity.js'

/** One place where the table schemas cross into dsh-storage-domain's `ZodType<V>` parameterisation; validation behavior is untouched. */
function triggerTable<K extends string, V>(schema: z.ZodType<V>): DomainTableSpec<K, V> {
  return domainTable<K, V>(schema)
}

export const SIGNAL_OUTCOMES = ['deliver', 'rework', 'pass', 'needs_user'] as const
export type SignalOutcome = (typeof SIGNAL_OUTCOMES)[number]

/** Narrow an untrusted tool argument into a signal verdict. */
export function isSignalOutcome(value: unknown): value is SignalOutcome {
  return typeof value === 'string' && SIGNAL_OUTCOMES.some((outcome) => outcome === value)
}

/** Whose turn it is inside an active run. */
export type RunPhase = 'awaiting-delivery' | 'awaiting-review'

/** Lifecycle status of a run; `phase` stays meaningful across the pauses. */
export type RunStatus =
  | 'active'
  | 'paused-user'
  | 'paused-budget'
  | 'paused-error'
  | 'completed'
  | 'cancelled'

/** A signal accepted from the tool, waiting for its turn to end. */
export interface PendingSignal {
  readonly outcome: SignalOutcome
  readonly summary: string
  readonly session?: string
  readonly turn: number
  readonly at: number
  readonly auto?: true
}

/** Which sides have already been nudged in their current round (bounded once per round). */
export interface NudgeState {
  readonly deliver?: number
  readonly review?: number
}

/** The deferred rework a `paused-budget` run holds until the budget grows. */
export interface PendingRework {
  readonly summary: string
  readonly round: number
}

/** One compact history line (bounded; the session logs stay the full record). */
export interface RunHistoryEntry {
  readonly at: number
  readonly kind:
    | 'started'
    | 'signal'
    | 'advance'
    | 'pause'
    | 'resume'
    | 'end'
    | 'note'
    | 'delivery'
    | 'nudge'
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
  readonly task: string
  readonly status: RunStatus
  readonly phase: RunPhase
  readonly round: number
  readonly maxRounds: number
  readonly executor: string
  readonly parent: string
  readonly templates: RunTemplateBodies
  readonly autoDeliver?: boolean
  readonly pendingSignal?: PendingSignal
  readonly pendingRework?: PendingRework
  readonly nudgeState?: NudgeState
  readonly outbox?: readonly OutboxEntry[]
  readonly consumedTurns?: { readonly executor?: number; readonly parent?: number }
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
  readonly autoDeliver?: boolean
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

export type DeliveryKind = 'start' | 'review' | 'rework' | 'notice' | 'resume' | 'nudge'

/** One queued prompt intent with its idempotency key. */
export interface DeliveryRecord {
  readonly id: string
  readonly runId: string
  readonly round: number
  readonly to: string
  readonly kind: DeliveryKind
  readonly requestId: string
  readonly state: 'pending' | 'sent' | 'failed'
  readonly content: string
  readonly createdAt: number
  readonly sentAt?: number
  readonly error?: string
}

export interface OutboxEntry {
  readonly id: string
  readonly runId: string
  readonly round: number
  readonly to: string
  readonly kind: DeliveryKind
  readonly requestId: string
  readonly content: string
  readonly state: 'pending' | 'failed'
  readonly bestEffort?: true
  readonly createdAt: number
}

const schemaSignalOutcome = z.enum(SIGNAL_OUTCOMES)
const schemaRunStatus = z.enum([
  'active',
  'paused-user',
  'paused-budget',
  'paused-error',
  'completed',
  'cancelled',
])
const schemaRunPhase = z.enum(['awaiting-delivery', 'awaiting-review'])

const schemaPendingSignal = z.object({
  outcome: schemaSignalOutcome,
  summary: z.string(),
  session: z.string().optional(),
  turn: z.number().int(),
  at: z.number(),
  auto: z.literal(true).optional(),
})

const schemaNudgeState = z.object({
  deliver: z.number().int().positive().optional(),
  review: z.number().int().positive().optional(),
})

const schemaPendingRework = z.object({
  summary: z.string(),
  round: z.number().int().positive(),
})

const schemaHistoryEntry = z.object({
  at: z.number(),
  kind: z.enum([
    'started',
    'signal',
    'advance',
    'pause',
    'resume',
    'end',
    'note',
    'delivery',
    'nudge',
  ]),
  detail: z.string().optional(),
})

const schemaTemplateBodies = z.object({
  start: z.string(),
  review: z.string(),
  rework: z.string(),
})

const schemaOutboxEntry = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  round: z.number().int().positive(),
  to: z.string().min(1),
  kind: z.enum(['start', 'review', 'rework', 'notice', 'resume', 'nudge']),
  requestId: z.string().min(1),
  state: z.enum(['pending', 'failed']),
  content: z.string(),
  bestEffort: z.literal(true).optional(),
  createdAt: z.number(),
})

const schemaRun = z
  .object({
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
    autoDeliver: z.boolean().optional(),
    pendingSignal: schemaPendingSignal.optional(),
    pendingRework: schemaPendingRework.optional(),
    nudgeState: schemaNudgeState.optional(),
    outbox: z.array(schemaOutboxEntry).optional(),
    consumedTurns: z
      .object({
        executor: z.number().int().optional(),
        parent: z.number().int().optional(),
      })
      .optional(),
    pausedBy: z.enum(['executor', 'parent']).optional(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    endNote: z.string().optional(),
    history: z.array(schemaHistoryEntry),
  })
  .refine((run) => run.pendingRework === undefined || run.status === 'paused-budget', {
    message: 'pendingRework only lives on a paused-budget run',
    path: ['pendingRework'],
  })
  .refine((run) => run.pendingSignal === undefined || run.status === 'active', {
    message: 'pendingSignal only lives on an active run',
    path: ['pendingSignal'],
  })

const schemaTemplateRefs = z.object({
  start: z.string().min(1),
  review: z.string().min(1),
  rework: z.string().min(1),
})

const schemaBinding = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    executor: z.string().min(1),
    parent: z.string().min(1),
    maxRounds: z.number().int().min(1).max(50),
    enabled: z.boolean(),
    autoDeliver: z.boolean().optional(),
    templates: schemaTemplateRefs,
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .refine((binding) => binding.executor !== binding.parent, {
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
  kind: z.enum(['start', 'review', 'rework', 'notice', 'resume', 'nudge']),
  requestId: z.string().min(1),
  state: z.enum(['pending', 'sent', 'failed']),
  content: z.string(),
  createdAt: z.number(),
  sentAt: z.number().optional(),
  error: z.string().optional(),
})

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
  return {
    start: BUILTIN_START_TEMPLATE,
    review: BUILTIN_REVIEW_TEMPLATE,
    rework: BUILTIN_REWORK_TEMPLATE,
  }
}

export const DEFAULT_MAX_ROUNDS = 5
