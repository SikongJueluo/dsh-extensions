/**
 * The persistent authorization store. Every permission fact is a record in
 * the plugin's storage domain; this class owns the ordering rules that the
 * domain itself does not provide (one write chain across tables), the path
 * admission checks, and the read model the policy service and browser panel
 * consume.
 *
 * Reads are synchronous from the domain's committed in-memory state. A
 * mutation resolves only after its records are durable; the group record is
 * the commit point for a permission change, and a request's status is
 * interaction state that can be reconciled from the group after a partial
 * failure.
 *
 * @module dsh-session-write-access/access
 */
import { randomUUID } from 'node:crypto'
import type { GroupRecord, GrantRecord, MemberRecord, RequestRecord, ForkRecord } from './domain.js'
import { admitWriteRoot, canonicalDirectory, findProtectedOverlap, pathContains } from './paths.js'

/** Minimal table surface this store needs; the real `KvTable` satisfies it. */
export interface AccessTable<V> {
  get(key: string): V | undefined
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, V]>
}

/** The tables of the plugin's domain, injectable for tests. */
export interface AccessTables {
  groups: AccessTable<GroupRecord>
  members: AccessTable<MemberRecord>
  requests: AccessTable<RequestRecord>
  forks: AccessTable<ForkRecord>
}

/** Durable session facts needed to attribute a cold session without its Agent. */
export interface SessionFacts {
  sessionId: string
  cwd?: string
  parentSessionId?: string
  origin?: 'subagent'
}

/** Reads one persisted session header; rejects/returns undefined when unknown. */
export type SessionLookup = (sessionId: string) => Promise<SessionFacts | undefined>

/** Stable error codes carried to the tool and the browser channel. */
export type AccessErrorCode =
  | 'NOT_ATTRIBUTED'
  | 'GROUP_MISSING'
  | 'PARENT_UNKNOWN'
  | 'REQUEST_MISSING'
  | 'STALE_REVISION'
  | 'FORK_MISSING'
  | 'FORK_BUSY'
  | 'NOT_FORKABLE'

/** A refusal the caller can report without inventing a new one. */
export class AccessError extends Error {
  readonly code: AccessErrorCode

  constructor(code: AccessErrorCode, message: string) {
    super(message)
    this.name = 'AccessError'
    this.code = code
  }
}

/** One grant with its effective-coverage explanation. */
export interface GrantView extends GrantRecord {
  /** A broader grant in the same group that already covers this one. */
  coveredBy?: string
}

/** One session's write-scope view, with no secret and no other group's data. */
export interface AccessStatus {
  sessionId: string
  groupId: string
  workspaceRoot: string
  revision: number
  grants: GrantView[]
  pending: RequestRecord[]
  recent: RequestRecord[]
}

/** Result of a user add: the new group plus an existing broader grant, if any. */
export interface AddResult {
  group: GroupRecord
  /** Set when the directory was already writable, so no revision changed. */
  coveredBy?: string
}

/** Result of a user revoke. */
export interface RemoveResult {
  group: GroupRecord
  removed: boolean
  /** A remaining broader grant that still makes the directory writable. */
  stillCoveredBy?: string
}

/** Result of an Agent request. */
export type RequestResult =
  | { kind: 'granted'; group: GroupRecord }
  | { kind: 'pending'; request: RequestRecord }

/** Result of a user decision. */
export interface DecisionResult {
  request: RequestRecord
  group: GroupRecord
  /** False for a repeated click on an already-decided request. */
  changed: boolean
}

/** Home of one group during cold attribution. */
interface RootFacts {
  sessionId: string
  facts: SessionFacts
}

/** Whether `parent` is the same directory as `child` or contains it. */
export function covers(parent: string, child: string): boolean {
  return pathContains(parent, child)
}

/**
 * The persistent authorization store.
 */
export class AccessStore {
  private readonly tables: AccessTables
  private readonly protectedRoots: readonly string[]
  private readonly workspaceFallback: string
  private readonly lookup: SessionLookup
  private readonly newId: () => string
  private readonly now: () => number
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param tables - the opened domain tables.
   * @param options - protected paths, workspace fallback, cold-session lookup,
   *   and injectable id/clock sources.
   */
  constructor(tables: AccessTables, options: {
    protectedRoots: readonly string[]
    workspaceFallback: string
    lookup: SessionLookup
    newId?: () => string
    now?: () => number
  }) {
    this.tables = tables
    this.protectedRoots = options.protectedRoots
    this.workspaceFallback = options.workspaceFallback
    this.lookup = options.lookup
    this.newId = options.newId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** Serialize one mutation behind every earlier mutation. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    // Keep the chain alive for later callers; their own rejection is observed
    // by the caller's slice, not by this bookkeeping promise.
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  /** The member record for a session, if the plugin has attributed it. */
  member(sessionId: string): MemberRecord | undefined {
    return this.tables.members.get(sessionId)
  }

  /** The group record for an id. */
  group(groupId: string): GroupRecord | undefined {
    return this.tables.groups.get(groupId)
  }

  /** All group records, used for the protected-path audit at load. */
  groups(): GroupRecord[] {
    return [...this.tables.groups.entries()].map(([, group]) => group)
  }

  /** All fork records, used for failure reporting and reconciliation. */
  forks(): ForkRecord[] {
    return [...this.tables.forks.entries()].map(([, fork]) => fork)
  }

  /** The group a session belongs to, refusing an unattributed session. */
  requireMember(sessionId: string): { member: MemberRecord; group: GroupRecord } {
    const member = this.tables.members.get(sessionId)
    if (member === undefined) {
      throw new AccessError('NOT_ATTRIBUTED', `session ${JSON.stringify(sessionId)} has no write-access group`)
    }
    const group = this.tables.groups.get(member.groupId)
    if (group === undefined) {
      throw new AccessError('GROUP_MISSING', `write-access group ${JSON.stringify(member.groupId)} is missing from storage`)
    }
    return { member, group }
  }

  /** Refuse a loaded state that would let workspace-write rewrite protected data. */
  auditProtectedState(): void {
    for (const group of this.groups()) {
      const workspaceOverlap = findProtectedOverlap(group.workspaceRoot, this.protectedRoots)
      if (workspaceOverlap !== undefined) {
        throw new Error(
          `session-write-access: stored group ${JSON.stringify(group.groupId)} has workspace `
          + `${JSON.stringify(group.workspaceRoot)} overlaps protected ${JSON.stringify(workspaceOverlap)}`,
        )
      }
      for (const grant of group.grants) {
        const overlap = findProtectedOverlap(grant.path, this.protectedRoots)
        if (overlap !== undefined) {
          throw new Error(
            `session-write-access: stored grant ${JSON.stringify(grant.path)} in group `
            + `${JSON.stringify(group.groupId)} overlaps protected ${JSON.stringify(overlap)}`,
          )
        }
      }
    }
  }

  /** Validate and canonicalize a session workspace before recording it. */
  private admitWorkspace(path: string | undefined): string {
    const physical = canonicalDirectory(path ?? this.workspaceFallback)
    const overlap = findProtectedOverlap(physical, this.protectedRoots)
    if (overlap !== undefined) {
      throw new Error(
        `session-write-access: refusing session workspace ${JSON.stringify(physical)}: it overlaps `
        + `protected ${JSON.stringify(overlap)}; run the session from a workspace separated from `
        + 'authorization storage, the profile, and plugin code',
      )
    }
    return physical
  }

  /** Create a group record when absent; caller already holds the write chain. */
  private async createGroupIfAbsent(root: RootFacts): Promise<GroupRecord> {
    const existing = this.tables.groups.get(root.sessionId)
    if (existing !== undefined) return existing
    const now = this.now()
    const group: GroupRecord = {
      version: 1,
      groupId: root.sessionId,
      workspaceRoot: this.admitWorkspace(root.facts.cwd),
      grants: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.tables.groups.put(group.groupId, group)
    return group
  }

  /**
   * Attribute one root session (a fresh session, a resume, or a plugin Fork).
   * The workspace is recorded once and never widened by a later cwd.
   * @param facts - durable session identities.
   * @param inherited - Fork workspace and click-time grants.
   */
  async ensureRootSession(
    facts: SessionFacts,
    inherited?: { workspaceRoot: string; grants: readonly string[]; forkSourceSessionId: string },
  ): Promise<MemberRecord> {
    const existing = this.tables.members.get(facts.sessionId)
    if (existing !== undefined) {
      this.requireMember(facts.sessionId)
      return existing
    }
    const workspaceRoot = inherited === undefined
      ? this.admitWorkspace(facts.cwd)
      : this.admitWorkspace(inherited.workspaceRoot)
    const inheritedGrants = inherited?.grants ?? []
    return this.enqueue(async () => {
      const current = this.tables.members.get(facts.sessionId)
      if (current !== undefined) return current
      const now = this.now()
      const existingGroup = this.tables.groups.get(facts.sessionId)
      let group: GroupRecord
      if (existingGroup === undefined) {
        group = {
          version: 1,
          groupId: facts.sessionId,
          workspaceRoot,
          grants: inheritedGrants.map(path => ({
            version: 1 as const,
            path,
            source: 'fork' as const,
            addedAt: now,
          })),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
        await this.tables.groups.put(group.groupId, group)
      } else if (inheritedGrants.length > 0 && existingGroup.grants.length === 0) {
        // A partial Fork wrote an empty group before it failed. The target is a
        // freshly created session that has not run a step, so completing its
        // inherited group is recovery, not widening a used session.
        group = {
          ...existingGroup,
          workspaceRoot,
          grants: inheritedGrants.map(path => ({
            version: 1 as const,
            path,
            source: 'fork' as const,
            addedAt: now,
          })),
          revision: existingGroup.revision + 1,
          updatedAt: now,
        }
        await this.tables.groups.put(group.groupId, group)
      } else {
        group = existingGroup
      }
      const member: MemberRecord = {
        version: 1,
        sessionId: facts.sessionId,
        groupId: group.groupId,
        role: 'root',
        ...inherited === undefined ? {} : { forkSourceSessionId: inherited.forkSourceSessionId },
        createdAt: now,
      }
      await this.tables.members.put(member.sessionId, member)
      return member
    })
  }

  /**
   * Walk parent links to the root session that owns a family's group. A cold
   * child is attributed from persisted headers, never from its own cwd.
   */
  private async collectRootFacts(sessionId: string): Promise<RootFacts> {
    let current = sessionId
    for (let depth = 0; depth < 64; depth += 1) {
      const member = this.tables.members.get(current)
      if (member !== undefined) {
        const { group } = this.requireMember(current)
        return { sessionId: member.groupId, facts: { sessionId: current, cwd: group.workspaceRoot } }
      }
      const facts = await this.lookup(current)
      if (facts === undefined) {
        throw new AccessError('PARENT_UNKNOWN', `parent session ${JSON.stringify(current)} is unknown; cannot attribute its child`)
      }
      if (facts.origin !== 'subagent') return { sessionId: current, facts }
      if (facts.parentSessionId === undefined) {
        throw new AccessError('PARENT_UNKNOWN', `subagent session ${JSON.stringify(current)} has no parentSession; cannot attribute`)
      }
      current = facts.parentSessionId
    }
    throw new AccessError('PARENT_UNKNOWN', `parent chain for ${JSON.stringify(sessionId)} exceeds the supported depth`)
  }

  /**
   * Attribute a local subagent to its family's group. The child's own cwd is
   * deliberately ignored: changing directory or creating a child must not
   * create a new writable root.
   * @param facts - durable child identities, including `parentSession`.
   */
  async ensureChildSession(facts: SessionFacts): Promise<MemberRecord> {
    const existing = this.tables.members.get(facts.sessionId)
    if (existing !== undefined) {
      this.requireMember(facts.sessionId)
      return existing
    }
    if (facts.parentSessionId === undefined) {
      throw new AccessError('PARENT_UNKNOWN', `subagent session ${JSON.stringify(facts.sessionId)} has no parentSession`)
    }
    const root = await this.collectRootFacts(facts.parentSessionId)
    return this.enqueue(async () => {
      const current = this.tables.members.get(facts.sessionId)
      if (current !== undefined) return current
      const group = await this.createGroupIfAbsent(root)
      if (this.tables.members.get(root.sessionId) === undefined) {
        const rootMember: MemberRecord = {
          version: 1,
          sessionId: root.sessionId,
          groupId: group.groupId,
          role: 'root',
          createdAt: this.now(),
        }
        await this.tables.members.put(rootMember.sessionId, rootMember)
      }
      const member: MemberRecord = {
        version: 1,
        sessionId: facts.sessionId,
        groupId: group.groupId,
        role: 'child',
        parentSessionId: facts.parentSessionId,
        createdAt: this.now(),
      }
      await this.tables.members.put(member.sessionId, member)
      return member
    })
  }

  /** Build the browser/tool read model for one session. */
  status(sessionId: string): AccessStatus {
    const { group } = this.requireMember(sessionId)
    const grants: GrantView[] = group.grants.map((grant) => {
      const broader = group.grants.find(other => other.path !== grant.path && covers(other.path, grant.path))
      return broader === undefined ? grant : { ...grant, coveredBy: broader.path }
    })
    const requests = [...this.tables.requests.entries()]
      .map(([, request]) => request)
      .filter(request => request.groupId === group.groupId)
      .sort((left, right) => right.createdAt - left.createdAt)
    return {
      sessionId,
      groupId: group.groupId,
      workspaceRoot: group.workspaceRoot,
      revision: group.revision,
      grants,
      // A manual add can make a pending request's directory writable before
      // anyone clicks Allow; it is no longer pending, and the grant (not the
      // request row) is the permission fact.
      pending: requests.filter(request =>
        request.status === 'pending'
        && !group.grants.some(grant => covers(grant.path, request.path))),
      recent: requests.slice(0, 20),
    }
  }

  /**
   * Add a directory as a user decision. The group record is the commit point;
   * nothing is published before the durable write resolves.
   * @param sessionId - any session in the target group.
   * @param path - submitted absolute directory.
   */
  async addGrant(sessionId: string, path: string): Promise<AddResult> {
    const physical = admitWriteRoot(path, this.protectedRoots)
    const { member } = this.requireMember(sessionId)
    return this.enqueue(async () => {
      const group = this.group(member.groupId)
      if (group === undefined) throw new AccessError('GROUP_MISSING', 'group vanished')
      const broader = group.grants.find(grant => covers(grant.path, physical))
      if (broader !== undefined) return { group, coveredBy: broader.path }
      const now = this.now()
      const next: GroupRecord = {
        ...group,
        grants: [...group.grants, { version: 1, path: physical, source: 'user', addedAt: now }],
        revision: group.revision + 1,
        updatedAt: now,
      }
      await this.tables.groups.put(next.groupId, next)
      return { group: next }
    })
  }

  /**
   * Revoke exactly one stored grant.
   * @param sessionId - any session in the group.
   * @param path - the stored path to remove.
   */
  async removeGrant(sessionId: string, path: string): Promise<RemoveResult> {
    const { member } = this.requireMember(sessionId)
    return this.enqueue(async () => {
      const group = this.group(member.groupId)
      if (group === undefined) throw new AccessError('GROUP_MISSING', 'group vanished')
      const remaining = group.grants.filter(grant => grant.path !== path)
      if (remaining.length === group.grants.length) return { group, removed: false }
      const next: GroupRecord = {
        ...group,
        grants: remaining,
        revision: group.revision + 1,
        updatedAt: this.now(),
      }
      await this.tables.groups.put(next.groupId, next)
      const stillCoveredBy = remaining.find(grant => covers(grant.path, path))?.path
      return { group: next, removed: true, ...stillCoveredBy === undefined ? {} : { stillCoveredBy } }
    })
  }

  /**
   * Submit one Agent request. The directory must already exist and must not
   * overlap protected data; an already-granted or already-pending directory
   * returns the existing fact instead of creating a duplicate.
   * @param sessionId - root or local child session.
   * @param path - requested absolute directory.
   * @param reason - why the Agent needs it (displayed to the user).
   */
  async request(sessionId: string, path: string, reason: string): Promise<RequestResult> {
    const physical = admitWriteRoot(path, this.protectedRoots)
    const trimmedReason = reason.trim().slice(0, 2000)
    if (trimmedReason.length === 0) throw new Error('a request needs a short reason for the user')
    const { member } = this.requireMember(sessionId)
    return this.enqueue(async () => {
      const group = this.group(member.groupId)
      if (group === undefined) throw new AccessError('GROUP_MISSING', 'group vanished')
      const broader = group.grants.find(grant => covers(grant.path, physical))
      if (broader !== undefined) return { kind: 'granted', group }
      const pending = [...this.tables.requests.entries()]
        .map(([, request]) => request)
        .find(request => request.groupId === group.groupId && request.status === 'pending' && request.path === physical)
      if (pending !== undefined) return { kind: 'pending', request: pending }
      const request: RequestRecord = {
        version: 1,
        requestId: this.newId(),
        groupId: group.groupId,
        sessionId,
        path: physical,
        reason: trimmedReason,
        status: 'pending',
        createdAt: this.now(),
      }
      await this.tables.requests.put(request.requestId, request)
      return { kind: 'pending', request }
    })
  }

  /**
   * Apply a user decision. A repeated click on an already-decided request is
   * idempotent; a stale page's expected revision is refused so an old Allow
   * cannot re-grant a directory after a newer revoke.
   * @param sessionId - session whose panel submitted the decision.
   * @param requestId - the request being decided.
   * @param decision - allow or deny.
   * @param expectedRevision - the group revision the panel displayed.
   */
  async decide(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    expectedRevision: number,
  ): Promise<DecisionResult> {
    const { member } = this.requireMember(sessionId)
    return this.enqueue(async () => {
      const request = this.tables.requests.get(requestId)
      const group = this.group(member.groupId)
      if (group === undefined) throw new AccessError('GROUP_MISSING', 'group vanished')
      if (request === undefined || request.groupId !== group.groupId) {
        throw new AccessError('REQUEST_MISSING', `request ${JSON.stringify(requestId)} does not belong to this group`)
      }
      if (request.status !== 'pending') return { request, group, changed: false }
      if (expectedRevision !== group.revision) {
        throw new AccessError(
          'STALE_REVISION',
          `the write scope changed since this page loaded (expected revision ${expectedRevision}, current ${group.revision}); reload and decide again`,
        )
      }
      const now = this.now()
      if (decision === 'deny') {
        const denied: RequestRecord = { ...request, status: 'denied', decidedAt: now, decidedBy: 'user' }
        await this.tables.requests.put(denied.requestId, denied)
        return { request: denied, group, changed: true }
      }
      const physical = admitWriteRoot(request.path, this.protectedRoots)
      const broader = group.grants.find(grant => covers(grant.path, physical))
      let next = group
      if (broader === undefined) {
        next = {
          ...group,
          grants: [...group.grants, { version: 1, path: physical, source: 'user', addedAt: now, requestId }],
          revision: group.revision + 1,
          updatedAt: now,
        }
        await this.tables.groups.put(next.groupId, next)
      }
      const allowed: RequestRecord = { ...request, status: 'allowed', decidedAt: now, decidedBy: 'user' }
      await this.tables.requests.put(allowed.requestId, allowed)
      return { request: allowed, group: next, changed: true }
    })
  }

  /**
   * Record a Fork intent with its click-time workspace and grant snapshot.
   * @param sourceSessionId - the session being forked.
   */
  async beginFork(sourceSessionId: string): Promise<ForkRecord> {
    this.requireMember(sourceSessionId)
    return this.enqueue(async () => {
      const { group } = this.requireMember(sourceSessionId)
      const now = this.now()
      const fork: ForkRecord = {
        version: 1,
        forkId: this.newId(),
        sourceSessionId,
        sourceGroupId: group.groupId,
        workspaceRoot: group.workspaceRoot,
        grants: group.grants.map(grant => grant.path),
        stage: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      await this.tables.forks.put(fork.forkId, fork)
      return fork
    })
  }

  /**
   * Create the target group and membership, or reuse an existing one. Caller
   * already holds the write chain. The caller wrote a `committing` record
   * naming the target first, so every record this writes is recoverable.
   */
  private async materializeFork(fork: ForkRecord, targetSessionId: string): Promise<GroupRecord> {
    const existingMember = this.tables.members.get(targetSessionId)
    if (existingMember !== undefined) {
      const existing = this.group(existingMember.groupId)
      if (existing === undefined) throw new AccessError('GROUP_MISSING', 'fork group vanished')
      return existing
    }
    const now = this.now()
    const existingGroup = this.group(targetSessionId)
    let group: GroupRecord
    if (existingGroup === undefined) {
      group = {
        version: 1,
        groupId: targetSessionId,
        workspaceRoot: fork.workspaceRoot,
        grants: fork.grants.map(path => ({ version: 1 as const, path, source: 'fork' as const, addedAt: now })),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      await this.tables.groups.put(group.groupId, group)
    } else if (fork.grants.length > 0 && existingGroup.grants.length === 0) {
      // Completing a group left empty by an interrupted commit. The target is
      // the freshly forked session, which the pre-step gate kept from running.
      group = {
        ...existingGroup,
        workspaceRoot: fork.workspaceRoot,
        grants: fork.grants.map(path => ({ version: 1 as const, path, source: 'fork' as const, addedAt: now })),
        revision: existingGroup.revision + 1,
        updatedAt: now,
      }
      await this.tables.groups.put(group.groupId, group)
    } else {
      group = existingGroup
    }
    const member: MemberRecord = {
      version: 1,
      sessionId: targetSessionId,
      groupId: group.groupId,
      role: 'root',
      forkSourceSessionId: fork.sourceSessionId,
      createdAt: now,
    }
    await this.tables.members.put(member.sessionId, member)
    return group
  }

  /**
   * Publish the new group for a Fork after the host returned its session id.
   * The `committing` record naming the target is the durable commit intent;
   * group and member follow, then the final `committed` marker. A failure at
   * any later write leaves records `reconcileForks` can finish.
   * @param forkId - the Fork record.
   * @param targetSessionId - the newly created session.
   */
  async commitFork(forkId: string, targetSessionId: string): Promise<GroupRecord> {
    return this.enqueue(async () => {
      const fork = this.tables.forks.get(forkId)
      if (fork === undefined) throw new AccessError('FORK_MISSING', `fork ${JSON.stringify(forkId)} is missing`)
      if (fork.stage === 'committed') {
        const member = this.tables.members.get(targetSessionId)
        if (member === undefined) throw new AccessError('GROUP_MISSING', 'committed fork has no membership')
        const group = this.group(member.groupId)
        if (group === undefined) throw new AccessError('GROUP_MISSING', 'fork group vanished')
        return group
      }
      const intent: ForkRecord = {
        ...fork,
        targetSessionId,
        stage: 'committing',
        updatedAt: this.now(),
      }
      if (fork.stage !== 'committing' || fork.targetSessionId !== targetSessionId) {
        await this.tables.forks.put(fork.forkId, intent)
      }
      const group = await this.materializeFork(intent, targetSessionId)
      await this.tables.forks.put(fork.forkId, {
        ...intent,
        stage: 'committed',
        updatedAt: this.now(),
      })
      return group
    })
  }

  /**
   * Persist the exact target session id as a `committing` intent. The service
   * calls this before retrying any permission write in its error path, so a
   * subsequent success or failure is always tied to a durable record.
   * @param forkId - the Fork record.
   * @param targetSessionId - the session the host created.
   */
  async recordForkTarget(forkId: string, targetSessionId: string): Promise<ForkRecord> {
    return this.enqueue(async () => {
      const fork = this.tables.forks.get(forkId)
      if (fork === undefined) throw new AccessError('FORK_MISSING', `fork ${JSON.stringify(forkId)} is missing`)
      if (fork.stage === 'committed') return fork
      const intent: ForkRecord = {
        ...fork,
        targetSessionId,
        stage: 'committing',
        updatedAt: this.now(),
      }
      await this.tables.forks.put(fork.forkId, intent)
      return intent
    })
  }

  /**
   * Record a host-side Fork failure that still reveals the created session.
   * No inherited permission is published; the target is kept for diagnosis.
   * @param forkId - the Fork record.
   * @param targetSessionId - the session the host created before failing.
   */
  async recordForkFailure(forkId: string, targetSessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const fork = this.tables.forks.get(forkId)
      if (fork === undefined || fork.stage === 'committed') return
      await this.tables.forks.put(fork.forkId, {
        ...fork,
        targetSessionId,
        stage: 'failed',
        updatedAt: this.now(),
      })
    })
  }

  /**
   * Remove every permission record published for a target whose commit could
   * not be confirmed, then mark the Fork failed. Membership is removed first
   * so the target cannot keep executing with a partial group.
   * @param forkId - the Fork record.
   * @param targetSessionId - the partially committed session.
   */
  async abortFork(forkId: string, targetSessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const fork = this.tables.forks.get(forkId)
      if (fork === undefined) throw new AccessError('FORK_MISSING', `fork ${JSON.stringify(forkId)} is missing`)
      if (fork.stage === 'committed') {
        throw new AccessError('FORK_MISSING', 'a committed Fork cannot be aborted')
      }
      // Mark failed first so a crash during cleanup cannot be reconciled back
      // into a committed, inherited group.
      await this.tables.forks.put(fork.forkId, {
        ...fork,
        targetSessionId,
        stage: 'failed',
        updatedAt: this.now(),
      })
      const member = this.tables.members.get(targetSessionId)
      if (member !== undefined && member.groupId === targetSessionId && member.role === 'root') {
        await this.tables.members.delete(targetSessionId)
      }
      if (this.tables.members.get(targetSessionId) === undefined && this.group(targetSessionId) !== undefined) {
        await this.tables.groups.delete(targetSessionId)
      }
    })
  }

  /**
   * Mark a Fork failed when its inherited permissions were NOT applied. A
   * `committed` record is never demoted.
   * @param forkId - the Fork record.
   */
  async failFork(forkId: string): Promise<void> {
    await this.enqueue(async () => {
      const fork = this.tables.forks.get(forkId)
      if (fork === undefined || fork.stage === 'committed' || fork.stage === 'failed') return
      await this.tables.forks.put(fork.forkId, { ...fork, stage: 'failed', updatedAt: this.now() })
    })
  }

  /**
   * Reconcile Fork records left behind by a crash or a partial write.
   * A `committing` record (or a legacy pending record with a target) is
   * completed from its own snapshot and marked committed; a pending record
   * without a target is marked failed. Never invents a target.
   */
  async reconcileForks(): Promise<void> {
    for (const fork of this.forks()) {
      if (fork.stage !== 'pending' && fork.stage !== 'committing') continue
      if (fork.targetSessionId === undefined) {
        if (fork.stage === 'pending') await this.failFork(fork.forkId)
        continue
      }
      const target = fork.targetSessionId
      await this.enqueue(async () => {
        const current = this.tables.forks.get(fork.forkId)
        if (current === undefined || current.stage === 'committed' || current.stage === 'failed') return
        await this.materializeFork(current, target)
        await this.tables.forks.put(fork.forkId, {
          ...current,
          targetSessionId: target,
          stage: 'committed',
          updatedAt: this.now(),
        })
      })
    }
  }

}
