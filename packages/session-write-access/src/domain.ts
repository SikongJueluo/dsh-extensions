/**
 * The plugin's durable record shapes and its one declared `storageDomain`.
 * Records are validated by zod at the durable boundary; the in-memory domain
 * view is authoritative for synchronous policy resolution, and every write
 * resolves only after the backend acknowledged it.
 *
 * @module dsh-session-write-access/domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Stable domain unit name; changing it would orphan every persisted grant. */
export const ACCESS_DOMAIN = 'session_write_access'
/** Current record format version, shared by every table. */
const RECORD_VERSION = 1 as const

const grantSchema = z.object({
  version: z.literal(RECORD_VERSION),
  /** Physical absolute directory. */
  path: z.string().min(1),
  /** Where the grant came from: a user action, or a Fork snapshot. */
  source: z.enum(['user', 'fork']),
  addedAt: z.number(),
  /** The request that produced this grant, when it came from an approval. */
  requestId: z.string().min(1).optional(),
})
/** One extra writable directory in a group. */
export type GrantRecord = z.infer<typeof grantSchema>

const groupSchema = z.object({
  version: z.literal(RECORD_VERSION),
  /** Group id equals the root session id that created it. */
  groupId: z.string().min(1),
  /** The family's one workspace-write root, frozen when the group was created. */
  workspaceRoot: z.string().min(1),
  grants: z.array(grantSchema),
  /** Monotonic version for stale UI decisions and auditability. */
  revision: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
/** One authorization group shared by a root session and its local children. */
export type GroupRecord = z.infer<typeof groupSchema>

const memberSchema = z.object({
  version: z.literal(RECORD_VERSION),
  sessionId: z.string().min(1),
  groupId: z.string().min(1),
  role: z.enum(['root', 'child']),
  /** Direct creator for a local subagent session. */
  parentSessionId: z.string().min(1).optional(),
  /** Root session this group was forked from, when the group came from the plugin Fork entry. */
  forkSourceSessionId: z.string().min(1).optional(),
  createdAt: z.number(),
})
/** One session's durable group membership. */
export type MemberRecord = z.infer<typeof memberSchema>

const requestSchema = z.object({
  version: z.literal(RECORD_VERSION),
  requestId: z.string().min(1),
  groupId: z.string().min(1),
  /** Session that submitted the request (root or local child). */
  sessionId: z.string().min(1),
  /** Physical absolute directory, validated before the record is written. */
  path: z.string().min(1),
  reason: z.string(),
  status: z.enum(['pending', 'allowed', 'denied']),
  createdAt: z.number(),
  decidedAt: z.number().optional(),
  /** The user decision that produced a non-pending status. */
  decidedBy: z.literal('user').optional(),
})
/** One persistent write-access request awaiting (or carrying) a user decision. */
export type RequestRecord = z.infer<typeof requestSchema>

const forkSchema = z.object({
  version: z.literal(RECORD_VERSION),
  forkId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceGroupId: z.string().min(1),
  /** Directory grants captured at click time. */
  grants: z.array(z.string()),
  /** Set only after the public Fork returned the new session id. */
  targetSessionId: z.string().min(1).optional(),
  stage: z.enum(['pending', 'committed', 'failed']),
  createdAt: z.number(),
  updatedAt: z.number(),
})
/** One plugin-Fork initialization record, used to recover and to report failures. */
export type ForkRecord = z.infer<typeof forkSchema>

/** The declared domain; the owning package defines it once. */
export const SESSION_WRITE_ACCESS_DOMAIN = defineDomain({
  name: ACCESS_DOMAIN,
  version: RECORD_VERSION,
  tables: {
    groups: domainTable<string, GroupRecord>(groupSchema),
    members: domainTable<string, MemberRecord>(memberSchema),
    requests: domainTable<string, RequestRecord>(requestSchema),
    forks: domainTable<string, ForkRecord>(forkSchema),
  },
})

export type AccessDomain = typeof SESSION_WRITE_ACCESS_DOMAIN
