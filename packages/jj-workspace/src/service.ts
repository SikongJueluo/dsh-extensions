/**
 * The `worktrees` provider that routes jj workspaces and keeps the stock Git
 * runtime for everything else.
 *
 * The stock Git service is not modified: it is constructed on an isolated
 * `worktrees` realm behind this provider, so Git behavior, configuration, and
 * disposal stay the shipped implementation. The jj arm runs its own pinned
 * sequence under the same Session policy, records the task association in the
 * project pool, and switches the Session directory only after the bookmark
 * exists.
 *
 * @module dsh-jj-workspace/service
 */
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  generatedWorktreeName,
  WorktreeService,
  type CreatedWorktree,
  type CreateWorktreePhase,
  type CreateWorktreeRequest,
  type RestoredWorktree,
  type RestoreWorktreeRequest,
} from '@deepseek-ai/dsh-experimental-worktree'
import { FsError } from '@deepseek-ai/dsh-fs'
import { workspaceWritableRoots, type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { registerChannel, type JjStatus } from './channel.js'
import {
  createJjWorkspace,
  findVcsRoot,
  isWithin,
  jjTaskRecord,
  listBookmarks,
  listWorkspaces,
  parseTaskRecords,
  projectRootOf,
  serializeTaskRecord,
  TASK_RECORD_FILE,
  taskRecordPath,
  type BookmarkInfo,
  type CreatedJjWorkspace,
  type JjTaskOrigin,
  type JjTaskRecord,
  type JjTaskState,
  type JjWorkspaceHost,
  type VcsProbe,
} from './jj.js'
import { appendTaskRecord, prepareJjDirectory, runJj, validateProcessConfig } from './process.js'

/** Worktree row configuration: the stock Git fields plus the jj arm's two choices. */
export interface Config {
  /** Relative Git checkout pool inside the source repository. */
  directory: string
  /** Prefix for automatically generated Git branch and checkout names. */
  namePrefix: string
  /** Executable name or absolute execution-world path of Git. */
  gitCommand: string
  /** Node executable used for sandboxed directory allocation. */
  nodeCommand: string
  /** Deadline in milliseconds for one command. */
  timeoutMs: number
  /** Subprocess termination grace in milliseconds. */
  graceMs: number
  /** Maximum captured bytes per subprocess output stream. */
  maxOutputBytes: number
  /** Relative jj workspace pool inside the source project. */
  workspaceDirectory: string
  /** Executable name or absolute execution-world path of jj 0.46 or newer. */
  jjCommand: string
  /** Mount the browser status channel; only the root provider must do this. */
  statusChannel: boolean
}

export const Config = z.object({
  directory: z
    .string()
    .default('.agents/worktrees')
    .description('Relative Git checkout pool inside the source repository.'),
  namePrefix: z
    .string()
    .default('dsh-')
    .description('Prefix for automatically generated branch, bookmark, and checkout names.'),
  gitCommand: z
    .string()
    .default('git')
    .description('Executable name or absolute execution-world path of Git.'),
  nodeCommand: z
    .string()
    .default('node')
    .description('Node executable used for sandboxed directory allocation.'),
  timeoutMs: z.number().default(60_000).description('Deadline in milliseconds for one command.'),
  graceMs: z.number().default(3_000).description('Subprocess termination grace in milliseconds.'),
  maxOutputBytes: z
    .number()
    .default(65_536)
    .description('Maximum captured bytes per subprocess output stream.'),
  workspaceDirectory: z
    .string()
    .default('.agents/workspaces')
    .description('Relative jj workspace pool inside the source project.'),
  jjCommand: z
    .string()
    .default('jj')
    .description('Executable name or absolute execution-world path of jj 0.46 or newer.'),
  statusChannel: z
    .boolean()
    .default(true)
    .description('Mount the browser status channel; only the root provider must do this.'),
})

/** What the jj arm adds to the stock creation result. */
export interface JjCreatedFields {
  vcs: 'jj'
  workspace: string
  bookmark: string
  /** Pinned parent change id. */
  baseChange: string
  /** Change id the task bookmark points at. */
  changeId: string
}

/** The creation result the tool and the Forge record consume. */
export type CreatedWorkspace =
  | (CreatedWorktree & { vcs: 'git' })
  | (CreatedWorktree & JjCreatedFields)

/** A creation request that also says which entry point started it. */
export type CreateWorkspaceRequest = CreateWorktreeRequest & { origin?: JjTaskOrigin }

/** The jj-workspace provider: one `worktrees` service with a Git delegate on an isolated realm. */
export default class JjWorktreeService extends Service {
  static inject = ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'sessions']
  static Config = Config

  readonly config: Config
  private readonly git: WorktreeService
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    validateProcessConfig(config)
    this.config = config
    // The stock runtime owns Git in a private service realm; the parent scope
    // sees only this provider, so disabling the shipped row loses no behavior.
    this.git = new WorktreeService(ctx.isolate('worktrees'), config)
    ctx.effect(
      () => async () => {
        this.lifetime.abort(new Error('jj workspace service disposed'))
        await Promise.allSettled(this.pending)
      },
      'jj-workspace: stop operations',
    )
    if (config.statusChannel) registerChannel(ctx, this)
  }

  /**
   * Create a workspace and enter it: a jj workspace plus a same-name task
   * bookmark when the Session is in a jj repository, otherwise the stock Git
   * worktree. Existing names or paths fail; a failed jj attempt retains what it
   * already created and reports the paths.
   */
  async create(
    agent: Agent,
    request: CreateWorkspaceRequest = {},
    signal?: AbortSignal,
    onPhase?: (phase: CreateWorktreePhase) => void,
  ): Promise<CreatedWorkspace> {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const root = await findVcsRoot(cwd, this.probe(signal), signal)
    if (root === undefined || !root.jj) {
      return { ...(await this.git.create(agent, request, signal, onPhase)), vcs: 'git' }
    }

    const operationSignal =
      signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const operation = this.createJj(agent, cwd, request, operationSignal, onPhase)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  /**
   * Restore a removed worktree through the stock Git runtime. A recorded jj
   * workspace is reported as unsupported instead of being handed to Git.
   */
  async restore(
    agent: Agent,
    request: RestoreWorktreeRequest,
    signal?: AbortSignal,
    onPhase?: (phase: CreateWorktreePhase) => void,
  ): Promise<RestoredWorktree> {
    if (
      (await this.isJjRoot(request.repositoryRoot, signal)) ||
      (await this.isJjRoot(request.path, signal))
    ) {
      throw new Error(
        `jj workspace restore is not supported: ${request.path}. The workspace directory and its task bookmark are retained; recreate or delete them with jj.`,
      )
    }
    return this.git.restore(agent, request, signal, onPhase)
  }

  /** Classify the Session's effective directory for the new-session option. */
  async status(sessionId: string): Promise<JjStatus> {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) return { kind: 'none' }
    const directory = this.ctx.workingDirectory.get(session)
    const root = await findVcsRoot(
      directory,
      this.probe(this.lifetime.signal),
      this.lifetime.signal,
    )
    if (root === undefined) return { kind: 'none' }
    if (!root.jj) return { kind: 'git', root: root.root }
    const git = await this.ctx.fs.lstat(join(root.root, '.git'), undefined, this.lifetime.signal)
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const host = this.hostFor(policy)
    try {
      const projectRoot = await projectRootOf(host, root.root, this.lifetime.signal)
      const bookmarks = await listBookmarks(host, root.root, this.lifetime.signal)
      return {
        kind: 'jj',
        root: root.root,
        hasGit: git !== undefined,
        blocker: jjBlocker(policy, projectRoot),
        bookmarks: [...bookmarks.keys()].toSorted(),
      }
    } catch {
      return {
        kind: 'jj',
        root: root.root,
        hasGit: git !== undefined,
        blocker: 'jj-unavailable',
        bookmarks: [],
      }
    }
  }

  /** Read the durable task associations of one project pool, without live jj state. */
  async tasks(projectRoot: string): Promise<JjTaskRecord[]> {
    return this.readRecords(projectRoot)
  }

  /**
   * Read the Session's jj tasks and observe their workspace and exact bookmark
   * names without moving or recreating anything. A moved, missing, or
   * conflicted bookmark is reported as such; a task whose workspace is gone is
   * reported, never restored.
   */
  async taskStates(sessionId: string): Promise<JjTaskState[]> {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) return []
    const directory = this.ctx.workingDirectory.get(session)
    const root = await findVcsRoot(
      directory,
      this.probe(this.lifetime.signal),
      this.lifetime.signal,
    )
    if (root?.jj !== true) return []
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const host = this.hostFor(policy)
    let projectRoot: string
    let records: JjTaskRecord[]
    try {
      projectRoot = await projectRootOf(host, root.root, this.lifetime.signal)
      records = (await this.readRecords(projectRoot)).filter(
        (record) => record.sessionId === sessionId,
      )
    } catch {
      return []
    }
    if (records.length === 0) return []
    let workspaces: Map<string, string>
    let bookmarks: Map<string, BookmarkInfo>
    try {
      workspaces = await listWorkspaces(host, projectRoot, this.lifetime.signal)
      bookmarks = await listBookmarks(host, projectRoot, this.lifetime.signal)
    } catch (error) {
      return records.map((record) => ({
        ...record,
        state: 'unavailable',
        message: messageOf(error),
      }))
    }
    const states: JjTaskState[] = []
    for (const record of records) {
      let matches: boolean
      try {
        matches = await this.workspaceMatches(record, workspaces, this.lifetime.signal)
      } catch (error) {
        states.push({ ...record, state: 'unavailable', message: messageOf(error) })
        continue
      }
      if (!matches) {
        states.push({ ...record, state: 'workspace-missing' })
        continue
      }
      const bookmark = bookmarks.get(record.bookmark)
      if (bookmark === undefined) {
        states.push({ ...record, state: 'bookmark-missing' })
        continue
      }
      if (bookmark.conflict) {
        states.push({ ...record, state: 'conflict' })
        continue
      }
      if (bookmark.changeId !== record.changeId) {
        states.push({ ...record, state: 'moved', currentChangeId: bookmark.changeId })
        continue
      }
      states.push({ ...record, state: 'ok' })
    }
    return states
  }

  /** Verify that a recorded workspace directory exists, is a jj workspace, and is the root jj registered. */
  private async workspaceMatches(
    record: JjTaskRecord,
    workspaces: Map<string, string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const registeredRoot = workspaces.get(record.workspace)
    if (registeredRoot === undefined) return false
    const directory = await this.ctx.fs.lstat(record.path, undefined, signal)
    if (directory?.type !== 'directory') return false
    const jj = await this.ctx.fs.lstat(join(record.path, '.jj'), undefined, signal)
    if (jj?.type !== 'directory') return false
    try {
      const recorded = await this.ctx.fs.resolve(record.path, { signal })
      const registered = await this.ctx.fs.resolve(registeredRoot, { signal })
      return recorded.targetKey === registered.targetKey
    } catch {
      // The registered root moved or vanished; the recorded directory is not
      // the workspace jj currently knows under that name.
      return false
    }
  }

  private async readRecords(projectRoot: string): Promise<JjTaskRecord[]> {
    const target = await this.ctx.fs.resolve(
      taskRecordPath(projectRoot, this.config.workspaceDirectory),
      {
        cwd: projectRoot,
      },
    )
    try {
      return parseTaskRecords(await this.ctx.fs.readText(target))
    } catch (error) {
      if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return []
      throw error
    }
  }

  private async createJj(
    agent: Agent,
    cwd: string,
    request: CreateWorkspaceRequest,
    signal: AbortSignal,
    onPhase?: (phase: CreateWorktreePhase) => void,
  ): Promise<CreatedWorktree & JjCreatedFields> {
    const name = request.name ?? generatedWorktreeName(this.config.namePrefix, agent.session.id)
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const created = await createJjWorkspace(this.hostFor(policy), {
      cwd,
      name,
      ...(request.from === undefined ? {} : { from: request.from }),
      poolDirectory: this.config.workspaceDirectory,
      signal,
      ...(onPhase === undefined ? {} : { onPhase }),
    })
    try {
      await this.appendRecord(
        created,
        jjTaskRecord(created, agent.session.id, request.origin ?? 'ui'),
        policy,
        signal,
      )
    } catch (error) {
      throw new Error(
        `jj workspace ${created.workspace} and bookmark ${created.bookmark} were created at ${created.path}, but their task record could not be written. ${messageOf(error)}`,
        { cause: error },
      )
    }
    let path: string
    try {
      path = await this.ctx.workingDirectory.set(agent, created.path, signal)
    } catch (error) {
      throw new Error(
        `jj workspace ${created.workspace} and bookmark ${created.bookmark} were created at ${created.path}, but the session directory could not be changed. ${messageOf(error)}`,
        { cause: error },
      )
    }
    return {
      path,
      branch: created.bookmark,
      baseCommit: created.baseCommit,
      repositoryRoot: created.repositoryRoot,
      vcs: 'jj',
      workspace: created.workspace,
      bookmark: created.bookmark,
      baseChange: created.baseChange,
      changeId: created.changeId,
    }
  }

  private async appendRecord(
    created: CreatedJjWorkspace,
    record: JjTaskRecord,
    policy: SandboxExecutionPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    await appendTaskRecord(
      this.ctx,
      this.config,
      policy,
      created.repositoryRoot,
      join(created.poolPath, TASK_RECORD_FILE),
      serializeTaskRecord(record),
      signal,
    )
  }

  private hostFor(policy: SandboxExecutionPolicy): JjWorkspaceHost {
    return {
      run: async (cwd, args, signal) => runJj(this.ctx, this.config, policy, cwd, args, signal),
      exists: async (path, signal) =>
        (await this.ctx.fs.lstat(path, undefined, signal)) !== undefined,
      prepare: async (projectRoot, poolPath, destination, signal) =>
        prepareJjDirectory(
          this.ctx,
          this.config,
          policy,
          projectRoot,
          poolPath,
          destination,
          signal,
        ),
    }
  }

  private probe(signal?: AbortSignal): VcsProbe {
    return {
      lstat: async (path) => {
        const info = await this.ctx.fs.lstat(path, undefined, signal)
        return info === undefined ? undefined : { type: info.type }
      },
    }
  }

  private async isJjRoot(path: string, signal?: AbortSignal): Promise<boolean> {
    const info = await this.ctx.fs.lstat(join(path, '.jj'), undefined, signal)
    return info?.type === 'directory'
  }
}

/** Decide whether the Session's policy can write the project pool and shared jj repository. */
function jjBlocker(policy: SandboxExecutionPolicy, projectRoot: string): JjStatus['blocker'] {
  if (policy.mode === 'read-only') return 'read-only'
  if (policy.mode === 'danger-full-access') return null
  return workspaceWritableRoots(policy).some((root) => isWithin(root, projectRoot))
    ? null
    : 'outside-writable-root'
}

/** The text of a failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
