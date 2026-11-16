/**
 * The sandbox-policy replacement. This service provides the stock
 * `ctx.sandboxPolicy` name and resolution rules, then adds the persistent
 * session authorization group to `workspace-write` calls. Filesystem tools and
 * confined shell read this same service, so one grant reaches both families.
 *
 * The replacement is pinned to the checked DSH composition: it subclasses the
 * stock `SandboxPolicyService` and reuses its mode fold and runtime-context
 * contribution rather than reimplementing them.
 *
 * @module dsh-session-write-access/service
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxPolicyRequest } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { AccessError, AccessStore } from './access.js'
import type {
  AccessStatus,
  DecisionResult,
  RemoveResult,
  RequestResult,
  SessionFacts,
} from './access.js'
import { registerWriteAccessChannel } from './channel.js'
import {
  Config as ConfigSchema,
  assertDeploymentRootsSafe,
  resolveConfiguredWorkspaceRoot,
  resolveProtectedRoots,
} from './config.js'
import type { Config } from './config.js'
import { ACCESS_DOMAIN, SESSION_WRITE_ACCESS_DOMAIN } from './domain.js'
import type { ForkRecord } from './domain.js'
import { applyGroupPolicy } from './policy.js'
import { registerWriteAccessTools } from './tools.js'

/** One session's browser-facing write scope, including deployment facts. */
export interface WriteScopeView extends AccessStatus {
  /** Deployment-level extra roots; displayed but not revocable from the panel. */
  deploymentRoots: readonly string[]
  /** The deployment default mode (before session overrides). */
  defaultMode: SandboxMode
  /** The mode this session would use for its next call. */
  effectiveMode: SandboxMode
  /** Recent Fork attempts started from this session, newest first. */
  forks: ForkRecord[]
}

/** Failure raised when a second plugin Fork starts while one is settling. */
export class ForkBusyError extends AccessError {
  constructor() {
    super(
      'FORK_BUSY',
      'another Fork is initializing; wait for it to finish before starting another',
    )
  }
}

/**
 * The policy service (`sandboxPolicy`) and owner of the persistent store.
 */
export class SessionWriteAccessPolicy extends SandboxPolicyService {
  static Config = ConfigSchema
  static inject = ['sessionProjections', 'storageDomain']

  private access: AccessStore | undefined
  private readonly protectedRoots: readonly string[]
  /** The deployment's stated fallback workspace, or undefined when it stated none. */
  private readonly configuredWorkspaceRoot: string | undefined
  /** Sessions attributed to a plugin Fork but not yet committed: steps are refused. */
  private readonly held = new Map<string, { cwd?: string }>()
  /** Sessions whose attribution failed: steps are refused with the recorded reason. */
  private readonly blocked = new Map<string, string>()
  private forkActive = false
  private domainOwned = false
  private domain: Domain<typeof SESSION_WRITE_ACCESS_DOMAIN> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.protectedRoots = resolveProtectedRoots(config)
    this.configuredWorkspaceRoot = resolveConfiguredWorkspaceRoot(config)
    assertDeploymentRootsSafe(config, this.protectedRoots)
  }

  protected async [Service.init](): Promise<void> {
    const facility = this.ctx.storageDomain
    const existing = facility.get(ACCESS_DOMAIN)
    const domain =
      existing === undefined
        ? await facility.open(SESSION_WRITE_ACCESS_DOMAIN)
        : (existing as unknown as Domain<typeof SESSION_WRITE_ACCESS_DOMAIN>)
    this.domain = domain
    this.domainOwned = existing === undefined
    this.access = new AccessStore(
      {
        groups: domain.table('groups'),
        members: domain.table('members'),
        requests: domain.table('requests'),
        forks: domain.table('forks'),
      },
      {
        protectedRoots: this.protectedRoots,
        workspaceFallback: this.configuredWorkspaceRoot,
        lookup: (sessionId) => this.lookupSession(sessionId),
      },
    )
    this.access.auditProtectedState()
    await this.access.reconcileForks()
    this.ctx.effect(() => () => this.closeDomain(), 'session-write-access domain')
    this.ctx.on('agent/created', async ({ agent }) => {
      await this.attributeSession(agent.session.id, agent.session.header)
    })
    this.ctx.on('agent/pre-step', async ({ agent }, next) => {
      const sessionId = agent.session.id
      if (this.blocked.has(sessionId)) return { kind: 'reject' as const }
      // Attribution is awaited HERE, before the step can run. A live child
      // whose parent header is slow therefore cannot execute with its own cwd
      // as the workspace while the sync resolver is still missing its member.
      if (this.access?.member(sessionId) === undefined) {
        try {
          await this.ensureSession(sessionId)
        } catch (error) {
          this.blocked.set(sessionId, error instanceof Error ? error.message : String(error))
          return { kind: 'reject' as const }
        }
      }
      // A held Fork target or a failed attribution still has no group.
      if (this.access?.member(sessionId) === undefined) return { kind: 'reject' as const }
      return next()
    })
    await super[Service.init]()
    registerWriteAccessChannel(this.ctx, this)
    this.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'sandbox:write-access',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
        text: (context) => {
          const session = context.agent?.session
          if (session === undefined || this.access?.member(session.id) === undefined) return ''
          return 'Persistent session write access: extra writable directories for this session are user-managed and persist across restarts; filesystem tools and confined shell share the same list. When a write outside the workspace is denied, call write_access_status, then write_access_request with the exact absolute directory and a short reason. Only the user can add, approve, or revoke a directory in the write-scope panel.'
        },
      })
    })
    this.ctx.inject(['tools'], (scope) => {
      registerWriteAccessTools(scope, this)
    })
    // A session can be created while this service is still initializing; the
    // listener above misses it, so attribute whatever is already live. A
    // failure keeps that session refused at pre-step instead of widening it.
    this.ctx.inject(['agents'], (scope) => {
      for (const agent of scope.agents.list()) {
        this.attributeSession(agent.session.id, agent.session.header).catch((error: unknown) => {
          this.ctx
            .logger('session-write-access')
            .warn('could not attribute an already-live session', {
              sessionId: agent.session.id,
              error: String(error),
            })
        })
      }
    })
  }

  private async closeDomain(): Promise<void> {
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined && this.domainOwned) await domain.close()
  }

  /** Read one persisted session header for cold child attribution. */
  private async lookupSession(sessionId: string): Promise<SessionFacts | undefined> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    try {
      const observation = await query.observeSession(SessionId(sessionId))
      const header = observation.header
      return {
        sessionId,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(header.parentSession === undefined
          ? {}
          : { parentSessionId: String(header.parentSession) }),
        ...(header.origin === undefined ? {} : { origin: header.origin }),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Attribute one created Agent before its first step. A parent failure
   * rejects creation: the session never runs with incomplete permissions.
   */
  private async attributeSession(
    sessionId: string,
    header: { cwd?: string; parentSession?: unknown; origin?: 'subagent'; isSeeded: boolean },
  ): Promise<void> {
    const access = this.access
    if (access === undefined)
      throw new Error('session-write-access: policy store is not initialized')
    const facts: SessionFacts = {
      sessionId,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.parentSession === undefined
        ? {}
        : { parentSessionId: String(header.parentSession) }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
    }
    try {
      if (header.origin === 'subagent') {
        await access.ensureChildSession(facts)
      } else if (header.isSeeded && this.forkActive && access.member(sessionId) === undefined) {
        // A plugin Fork target: hold its steps until the Fork call returns and
        // the exact new id is committed. Never guess the target from events.
        this.held.set(sessionId, header.cwd === undefined ? {} : { cwd: header.cwd })
        return
      } else {
        await access.ensureRootSession(facts)
      }
      this.blocked.delete(sessionId)
    } catch (error) {
      this.blocked.set(sessionId, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /**
   * Fork through the public Session Controller, then publish the new group.
   * While the host call is in flight, seeded root sessions are held at
   * `agent/pre-step`; attribution uses only the id the host returns.
   * @param sessionId - source session.
   * @param atSeq - optional inclusive event boundary.
   * @returns the new session id after its group is durable.
   */
  async forkSession(sessionId: string, atSeq?: number): Promise<{ sessionId: string }> {
    const access = this.requireAccess()
    if (this.forkActive) throw new ForkBusyError()
    if (access.requireMember(sessionId).member.role !== 'root') {
      throw new AccessError(
        'NOT_FORKABLE',
        'fork a root session; a local subagent shares its family group already',
      )
    }
    // Claim the one in-process Fork slot synchronously: two concurrent entry
    // clicks must not both pass the check above while beginFork awaits.
    this.forkActive = true
    let fork: ForkRecord | undefined
    let childId: string | undefined
    try {
      fork = await access.beginFork(sessionId)
      const controller = this.ctx.get('sessionController')
      if (controller === undefined)
        throw new Error('session-write-access: sessionController is unavailable; cannot fork')
      const created = await controller.fork({
        sessionId: SessionId(sessionId),
        ...(atSeq === undefined ? {} : { atSeq }),
      })
      childId = String(created.sessionId)
      await access.commitFork(fork.forkId, childId)
      return { sessionId: childId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const hostSucceeded = childId !== undefined
      // The controller creates the session before workspace attach; a failure
      // after creation reports the id in its details. Only a returned id means
      // the Fork itself completed.
      const reported = childId ?? detailSessionId(error, sessionId)
      if (fork !== undefined && hostSucceeded && reported !== undefined) {
        // Persist the exact target before retrying any permission write. The
        // normal commit already wrote this intent first; this retry covers a
        // failure of that first write.
        let applied = false
        try {
          await access.recordForkTarget(fork.forkId, reported)
          await access.reconcileForks()
          applied = this.forkGrantsApplied(reported, fork)
        } catch {
          // Judged from the actual committed state below.
        }
        if (applied) {
          // Host Fork succeeded and the inherited permissions are durable.
          try {
            await access.reconcileForks()
          } catch {
            // Reconcile retries at next load; permissions are already real.
          }
          return { sessionId: reported }
        }
        // Withdraw anything partially published so a reported failure cannot
        // later resurrect the captured grants through orphan records.
        let aborted = false
        try {
          await access.abortFork(fork.forkId, reported)
          aborted = true
        } catch {
          aborted = false
        }
        if (!aborted) {
          throw new Error(
            `Fork created session ${reported}; its inherited directories are not confirmed and the Fork record ` +
              `could not be finalized: ${message}. Inspect the write-scope panel before using it.`,
          )
        }
        const stillApplied = this.forkGrantsPresent(reported, fork)
        if (stillApplied) {
          throw new Error(
            `Fork created session ${reported}; cleanup left its inherited directories applied and the Fork record ` +
              `failed: ${message}. Inspect the write-scope panel before using it.`,
          )
        }
        try {
          await access.ensureRootSession({
            sessionId: reported,
            ...this.held.get(reported),
          })
        } catch {
          // Pre-step retries attribution; no inherited permission is recorded.
        }
        throw new Error(
          `Fork created session ${reported} but its inherited directories could not be committed: ${message}. ` +
            'It has the default workspace only.',
        )
      }
      if (fork !== undefined) {
        if (reported !== undefined) {
          // Host Fork failed after creating the session: never publish the
          // captured permissions; keep the target for diagnosis and default
          // the session to its own workspace.
          try {
            await access.recordForkFailure(fork.forkId, reported)
          } catch {
            // The record stays pending; no permission was published.
          }
          try {
            await access.ensureRootSession({
              sessionId: reported,
              ...this.held.get(reported),
            })
          } catch {
            // Pre-step retries attribution; no inherited permission is recorded.
          }
          throw new Error(
            `Fork failed after creating session ${reported}: ${message}. It has the default workspace only and ` +
              'did not inherit the captured grants.',
          )
        }
        await access.failFork(fork.forkId)
      }
      throw error
    } finally {
      await this.releaseHeld(childId)
    }
  }

  /** Release held Fork candidates; a non-target seeded session gets a fresh default group. */
  private async releaseHeld(claimedId: string | undefined): Promise<void> {
    this.forkActive = false
    const pending = [...this.held.entries()]
    this.held.clear()
    for (const [sessionId, facts] of pending) {
      if (sessionId === claimedId) continue
      try {
        await this.requireAccess().ensureRootSession({ sessionId, ...facts })
      } catch (error) {
        this.blocked.set(sessionId, error instanceof Error ? error.message : String(error))
        this.ctx
          .logger('session-write-access')
          .warn('could not attribute a session created during Fork; its steps stay refused', {
            sessionId,
            error: String(error),
          })
      }
    }
  }

  private requireAccess(): AccessStore {
    if (this.access === undefined)
      throw new Error('session-write-access: policy store is not initialized')
    return this.access
  }

  /** Whether the target has a group carrying every directory captured by the Fork. */
  private forkGrantsApplied(targetSessionId: string, fork: ForkRecord): boolean {
    const member = this.access?.member(targetSessionId)
    if (member === undefined) return false
    return this.forkGrantsPresent(targetSessionId, fork)
  }

  /** Whether an orphan group still carries the Fork's captured directories. */
  private forkGrantsPresent(targetSessionId: string, fork: ForkRecord): boolean {
    const group = this.access?.group(targetSessionId)
    if (group === undefined) return false
    return fork.grants.every((path) => group.grants.some((grant) => grant.path === path))
  }

  /**
   * Attribute a live session on demand. Used by the tools and the browser
   * route so a session whose creation raced plugin initialization can still
   * be managed; an unknown session is refused rather than guessed.
   * @param sessionId - live session to attribute.
   */
  async ensureSession(sessionId: string): Promise<void> {
    const access = this.requireAccess()
    if (access.member(sessionId) !== undefined) {
      access.requireMember(sessionId)
      return
    }
    const live = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (live === undefined) {
      throw new AccessError(
        'NOT_ATTRIBUTED',
        `session ${JSON.stringify(sessionId)} is not live and has no write-access group`,
      )
    }
    await this.attributeSession(sessionId, live.session.header)
  }

  /**
   * Resolve one capability call: the stock mode and workspace, plus the
   * family's recorded workspace and grants. A child never gains a writable
   * root from its own cwd: an unattributed child refuses to resolve, while an
   * unattributed root keeps the stock policy for its own workspace.
   */
  override resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const base = super.resolve(request)
    const session = request.session
    // The stock fallback is `config.workspaceRoot ?? process.cwd()`. Once the
    // deployment states none, a call with no session cwd has no stated root;
    // refuse it instead of granting the directory the host happens to run in.
    if (
      base.mode === 'workspace-write' &&
      session?.header.cwd === undefined &&
      this.configuredWorkspaceRoot === undefined
    ) {
      throw new Error(
        'session-write-access: this call has no session cwd and the deployment configures no workspaceRoot; ' +
          'refusing to derive a writable workspace from the process cwd',
      )
    }
    if (session === undefined || this.access === undefined) return base
    const member = this.access.member(session.id)
    if (member === undefined) {
      // A child without a committed member would otherwise resolve to its own
      // cwd. Fail closed instead of treating a not-yet-attributed child as a
      // top-level session; pre-step awaits attribution before tools can run.
      if (session.header.origin === 'subagent') {
        throw new Error(
          `session-write-access: subagent ${JSON.stringify(session.id)} has no committed write-access group yet; ` +
            'refusing to resolve its cwd as a writable root',
        )
      }
      return base
    }
    const group = this.access.group(member.groupId)
    if (group === undefined) {
      throw new Error(
        `session-write-access: group ${JSON.stringify(member.groupId)} is missing; refusing to resolve a partial policy`,
      )
    }
    return applyGroupPolicy(base, group)
  }

  /** The browser/tool read model for one session. */
  view(sessionId: string): WriteScopeView {
    const access = this.requireAccess()
    const status = access.status(sessionId)
    const live = this.ctx.get('agents')?.get(SessionId(sessionId))
    const forks = access
      .forks()
      .filter((fork) => fork.sourceSessionId === sessionId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 5)
    return {
      ...status,
      deploymentRoots: this.additionalWritableRoots ?? [],
      defaultMode: this.defaultMode,
      effectiveMode:
        live === undefined ? this.defaultMode : this.resolve({ session: live.session }).mode,
      forks,
    }
  }

  /** Add a directory as the user; returns the refreshed view. */
  async addDirectory(
    sessionId: string,
    path: string,
  ): Promise<WriteScopeView & { coveredBy?: string }> {
    const result = await this.requireAccess().addGrant(sessionId, path)
    return {
      ...this.view(sessionId),
      ...(result.coveredBy === undefined ? {} : { coveredBy: result.coveredBy }),
    }
  }

  /** Revoke one directory as the user; returns the refreshed view. */
  async removeDirectory(
    sessionId: string,
    path: string,
  ): Promise<WriteScopeView & { removed: boolean; stillCoveredBy?: string }> {
    const result: RemoveResult = await this.requireAccess().removeGrant(sessionId, path)
    return {
      ...this.view(sessionId),
      removed: result.removed,
      ...(result.stillCoveredBy === undefined ? {} : { stillCoveredBy: result.stillCoveredBy }),
    }
  }

  /** Submit an Agent request; returns the pending record (or the existing grant). */
  async requestDirectory(sessionId: string, path: string, reason: string): Promise<RequestResult> {
    return this.requireAccess().request(sessionId, path, reason)
  }

  /** Apply a user decision and return the refreshed view plus the decision. */
  async decideRequest(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    expectedRevision: number,
  ): Promise<WriteScopeView & { decision: DecisionResult }> {
    const result = await this.requireAccess().decide(
      sessionId,
      requestId,
      decision,
      expectedRevision,
    )
    return { ...this.view(sessionId), decision: result }
  }
}

/** Read the created-session id a Remote failure carries in its details. */
function detailSessionId(error: unknown, sourceSessionId: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const details = (error as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return undefined
  const sessionId = (details as { sessionId?: unknown }).sessionId
  // Fork failures that name the SOURCE session (not found, no completed turn)
  // are not evidence of a created child.
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId !== sourceSessionId
    ? sessionId
    : undefined
}

export default SessionWriteAccessPolicy
