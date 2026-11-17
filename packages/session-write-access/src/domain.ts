/** @module dsh-session-write-access/domain */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const ACCESS_DOMAIN = 'session_write_access'
const RECORD_VERSION = 1 as const

const grantSchema = z.object({
  version: z.literal(RECORD_VERSION),
  path: z.string().min(1),
  source: z.enum(['user', 'fork']),
  addedAt: z.number(),
  requestId: z.string().min(1).optional(),
})
/** One extra writable directory in a group. */
export type GrantRecord = z.infer<typeof grantSchema>

const groupSchema = z.object({
  version: z.literal(RECORD_VERSION),
  groupId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  grants: z.array(grantSchema),
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
  parentSessionId: z.string().min(1).optional(),
  forkSourceSessionId: z.string().min(1).optional(),
  createdAt: z.number(),
})
/** One session's durable group membership. */
export type MemberRecord = z.infer<typeof memberSchema>

const requestSchema = z.object({
  version: z.literal(RECORD_VERSION),
  requestId: z.string().min(1),
  groupId: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().min(1),
  reason: z.string(),
  status: z.enum(['pending', 'allowed', 'denied']),
  createdAt: z.number(),
  decidedAt: z.number().optional(),
  decidedBy: z.literal('user').optional(),
})
/** One persistent write-access request awaiting (or carrying) a user decision. */
export type RequestRecord = z.infer<typeof requestSchema>

const forkSchema = z.object({
  version: z.literal(RECORD_VERSION),
  forkId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceGroupId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  grants: z.array(z.string()),
  targetSessionId: z.string().min(1).optional(),
  stage: z.enum(['pending', 'committing', 'committed', 'failed']),
  createdAt: z.number(),
  updatedAt: z.number(),
})
/** One plugin-Fork initialization record, used to recover and to report failures. */
export type ForkRecord = z.infer<typeof forkSchema>

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
