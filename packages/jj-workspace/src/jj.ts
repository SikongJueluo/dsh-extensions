/**
 * The jj domain behind the worktree entry points.
 *
 * This module owns the whole jj creation sequence: find the workspace, pin a
 * base change, allocate the destination exclusively, add the workspace, create
 * the same-name task bookmark, and describe the record the caller persists.
 * Callers supply a command runner, path probe, and directory allocator; the
 * Cordis adapter binds them to the Session's sandbox policy, while tests bind
 * them to a plain temporary repository.
 *
 * @module dsh-jj-workspace/jj
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The two creation phases the worktree runtime exposes to its consumers. */
export type JjCreatePhase = 'prepare' | 'checkout'

/** Why a workspace was created: the model tool or the new-session option. */
export type JjTaskOrigin = 'tool' | 'ui'

/** What one successful jj creation produced. */
export interface CreatedJjWorkspace {
  /** Canonical destination after `jj workspace add`. */
  path: string
  /** Workspace name, identical to the task bookmark and the directory name. */
  workspace: string
  /** Task bookmark at the new workspace's initial working-copy commit. */
  bookmark: string
  /** Change id the task bookmark points at. */
  changeId: string
  /** Change id pinned as the new workspace's parent. */
  baseChange: string
  /** Commit id of `baseChange`, the value Forge records as `baseCommit`. */
  baseCommit: string
  /** Default-workspace root of the shared jj repository (the source project). */
  repositoryRoot: string
  /** Pool directory that holds the workspace. */
  poolPath: string
}

/** One durable association between a Session, a jj workspace, and its bookmark. */
export interface JjTaskRecord {
  version: 1
  sessionId: string
  projectRoot: string
  workspace: string
  path: string
  bookmark: string
  changeId: string
  baseChange: string
  baseCommit: string
  origin: JjTaskOrigin
  createdAt: string
}

/** The live state of one recorded task, as observed without mutating jj. */
export type JjTaskStateCode =
  | 'ok'
  | 'moved'
  | 'bookmark-missing'
  | 'workspace-missing'
  | 'conflict'
  | 'unavailable'

/** A recorded task plus the current state of its workspace and bookmark. */
export interface JjTaskState extends JjTaskRecord {
  state: JjTaskStateCode
  /** Bookmark target change id when it still exists and differs from the recorded one. */
  currentChangeId?: string
  /** Why the observation failed, for `unavailable`. */
  message?: string
}

/** One local bookmark's name, conflict flag, and normal target. */
export interface BookmarkInfo {
  name: string
  conflict: boolean
  changeId: string
}

/** The file the record is appended to, inside the workspace pool. */
export const TASK_RECORD_FILE = '.dsh-jj-workspace-records.jsonl'

/** Execution seams the domain needs; the adapter decides sandbox, the test decides the process. */
export interface JjWorkspaceHost {
  /**
   * Run a jj subcommand in `cwd` and return standard output.
   * The host supplies global flags and the inherited environment.
   * @throws when jj rejects the command or exits non-zero.
   */
  run(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string>
  /** Whether `path` exists (a file, directory, or symlink). */
  exists(path: string, signal: AbortSignal): Promise<boolean>
  /**
   * Create `poolPath` (self-ignoring when newly created) and `destination`
   * exclusively. An existing destination rejects the whole creation.
   */
  prepare(
    projectRoot: string,
    poolPath: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void>
}

/** Inputs of one jj workspace creation. */
export interface CreateJjWorkspaceRequest {
  /** Directory the calling Session currently works in. */
  cwd: string
  /** Workspace name, task bookmark name, and destination directory name. */
  name: string
  /** Change id or bookmark to start from; omitted means the current change `@`. */
  from?: string
  /** Relative pool directory inside the source project. */
  poolDirectory: string
  signal: AbortSignal
  onPhase?: (phase: JjCreatePhase) => void
}

/** A path-level probe result; the subset of `FsPathInfo` the detector needs. */
export interface VcsPathInfo {
  type: 'file' | 'directory' | 'symlink' | 'other'
}

/** Path probe used to find the nearest VCS root. */
export interface VcsProbe {
  lstat(path: string): Promise<VcsPathInfo | undefined>
}

/** The nearest VCS root and which VCS owns it. */
export interface VcsRoot {
  root: string
  jj: boolean
}

/** The common prefix of every jj command; the adapter prepends the executable and environment. */
const LIST_TEMPLATE = 'name ++ "\\n"'
const ROOT_TEMPLATE = 'root ++ "\\n"'

/** Read one template field of one revision. */
async function readOne(
  host: JjWorkspaceHost,
  cwd: string,
  revision: string,
  field: 'change_id' | 'commit_id',
  signal: AbortSignal,
): Promise<string> {
  const output = await host.run(
    cwd,
    ['--ignore-working-copy', 'log', '-r', revision, '--no-graph', '-T', `${field} ++ "\\n"`],
    signal,
  )
  const values = output.split('\n').filter((line) => line.length > 0)
  if (values.length !== 1) {
    throw new Error(
      `jj revision ${JSON.stringify(revision)} must name exactly one change, not ${values.length}`,
    )
  }
  return values[0]!
}

/** Resolve an explicit base revision to its pinned change id. */
async function resolveFrom(
  host: JjWorkspaceHost,
  cwd: string,
  from: string,
  signal: AbortSignal,
): Promise<string> {
  if (from.startsWith('-')) throw new Error('jj base must not start with "-"')
  const output = await host.run(
    cwd,
    ['--ignore-working-copy', 'log', '-r', from, '--no-graph', '-T', 'change_id ++ "\\n"'],
    signal,
  )
  const values = output.split('\n').filter((line) => line.length > 0)
  if (values.length !== 1) {
    throw new Error(
      `jj base ${JSON.stringify(from)} must name exactly one change, not ${values.length}`,
    )
  }
  return values[0]!
}

/**
 * Find the default workspace root: the shallowest listed root containing the
 * current workspace. The default workspace is the shared project root; when
 * the current workspace lives outside it (or the repository has no default),
 * the current workspace root is the fallback.
 */
export async function projectRootOf(
  host: JjWorkspaceHost,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<string> {
  const output = await host.run(
    workspaceRoot,
    ['--ignore-working-copy', 'workspace', 'list', '-T', ROOT_TEMPLATE],
    signal,
  )
  const current = resolve(workspaceRoot)
  const roots = [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ]
    .map((root) => resolve(root))
    .filter((root) => isWithin(root, current))
    .sort((left, right) => left.length - right.length)
  return roots[0] ?? current
}

/** Reject a workspace, bookmark, and directory name before any command runs. */
export function validateWorkspaceName(name: string): string | undefined {
  if (name.length === 0) return 'workspace name must not be empty'
  if (name.length > 120) return 'workspace name must be at most 120 characters'
  if (name.startsWith('-')) return 'workspace name must not start with "-"'
  if (name.includes('\\') || name.includes(':') || name.includes(' ')) {
    return 'workspace name must not contain spaces, "\\", or ":"'
  }
  for (const segment of name.split('/')) {
    if (segment.length === 0) return 'workspace name must not contain empty path segments'
    if (segment === '.' || segment === '..')
      return 'workspace name must not contain "." or ".." segments'
    if (segment.includes('..') || segment.endsWith('.') || segment.endsWith('.lock')) {
      return 'workspace name segments must not contain "..", end with ".", or end with ".lock"'
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
      return 'workspace name segments must start with a letter or digit and contain only letters, digits, ".", "_", or "-"'
    }
  }
  return undefined
}

/** Whether `child` is `parent` or lies below it after lexical normalization. */
export function isWithin(parent: string, child: string): boolean {
  const rest = relative(resolve(parent), resolve(child))
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/**
 * Find the nearest ancestor that is a Git checkout or a jj workspace.
 * A nested Git worktree (a `.git` file at its root) is Git even when an outer
 * directory is a jj workspace; a colocated workspace has both markers and is jj.
 */
export async function findVcsRoot(
  cwd: string,
  probe: VcsProbe,
  signal?: AbortSignal,
): Promise<VcsRoot | undefined> {
  let directory = resolve(cwd)
  for (;;) {
    signal?.throwIfAborted()
    const jj = await probe.lstat(join(directory, '.jj'))
    if (jj?.type === 'directory') return { root: directory, jj: true }
    const git = await probe.lstat(join(directory, '.git'))
    if (git !== undefined) return { root: directory, jj: false }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** List workspace names with their registered roots. */
export async function listWorkspaces(
  host: JjWorkspaceHost,
  cwd: string,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const output = await host.run(
    cwd,
    ['--ignore-working-copy', 'workspace', 'list', '-T', 'name ++ "\\t" ++ root ++ "\\n"'],
    signal,
  )
  const workspaces = new Map<string, string>()
  for (const line of output.split('\n')) {
    if (line.length === 0) continue
    const [name = '', root = ''] = line.split('\t')
    if (name.length > 0 && root.length > 0) workspaces.set(name, root)
  }
  return workspaces
}

/**
 * List local present bookmarks by exact name with their conflict flag and
 * normal target. Remote-tracking rows and absent local rows are dropped; a
 * conflicted bookmark never reads its empty normal target.
 */
export async function listBookmarks(
  host: JjWorkspaceHost,
  cwd: string,
  signal: AbortSignal,
): Promise<Map<string, BookmarkInfo>> {
  const template =
    'name ++ "\\t" ++ self.remote() ++ "\\t" ++ self.present() ++ "\\t" ++ self.conflict()' +
    ' ++ "\\t" ++ if(self.conflict(), "", if(self.present(), normal_target.change_id(), "")) ++ "\\n"'
  const output = await host.run(
    cwd,
    ['--ignore-working-copy', 'bookmark', 'list', '-T', template],
    signal,
  )
  const bookmarks = new Map<string, BookmarkInfo>()
  for (const line of output.split('\n')) {
    if (line.length === 0) continue
    const [name = '', remote = '', present = 'false', conflict = 'false', changeId = ''] =
      line.split('\t')
    if (name.length === 0 || remote.length > 0 || present !== 'true') continue
    bookmarks.set(name, { name, conflict: conflict === 'true', changeId })
  }
  return bookmarks
}

/** Path of the association record inside one project's pool. */
export function taskRecordPath(projectRoot: string, poolDirectory: string): string {
  return join(projectRoot, poolDirectory, TASK_RECORD_FILE)
}

/** Serialize one record as one JSON line. */
export function serializeTaskRecord(record: JjTaskRecord): string {
  return `${JSON.stringify(record)}\n`
}

/** Parse a record file into records, ignoring trailing blank lines. */
export function parseTaskRecords(text: string): JjTaskRecord[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JjTaskRecord)
}

/** The text of a failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Ensure the workspace name is free and the destination is absent. */
async function assertAvailable(
  host: JjWorkspaceHost,
  workspaceRoot: string,
  name: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  if ((await listWorkspaces(host, workspaceRoot, signal)).has(name)) {
    throw new Error(`jj workspace already exists: ${name}`)
  }
  if ((await listBookmarks(host, workspaceRoot, signal)).has(name)) {
    throw new Error(`jj bookmark already exists: ${name}`)
  }

  if (await host.exists(destination, signal))
    throw new Error(`workspace path already exists: ${destination}`)
}

/**
 * Create and describe one jj workspace.
 *
 * The destination is allocated exclusively before `jj workspace add`; an
 * occupied name or path rejects before allocation. A failure after allocation
 * leaves the directory, workspace, or bookmark it created in place and says
 * so; nothing is rolled back.
 *
 * @param host - command, path, and allocation seams.
 * @param request - name, base, pool, Session directory, and cancellation.
 * @returns the created workspace and the values the caller records.
 */
export async function createJjWorkspace(
  host: JjWorkspaceHost,
  request: CreateJjWorkspaceRequest,
): Promise<CreatedJjWorkspace> {
  const { cwd, name, from, poolDirectory, signal, onPhase } = request
  signal.throwIfAborted()
  const invalid = validateWorkspaceName(name)
  if (invalid !== undefined) throw new Error(invalid)

  onPhase?.('prepare')
  const workspaceRoot = (await host.run(cwd, ['--ignore-working-copy', 'root'], signal)).trim()
  if (workspaceRoot.length === 0) throw new Error('jj root printed no workspace root')
  const projectRoot = await projectRootOf(host, workspaceRoot, signal)
  const poolPath = resolve(projectRoot, poolDirectory)
  const destination = resolve(poolPath, name)
  if (
    !isWithin(projectRoot, poolPath) ||
    !isWithin(poolPath, destination) ||
    poolPath === destination
  ) {
    throw new Error(`workspace destination escapes the project pool: ${destination}`)
  }

  await assertAvailable(host, workspaceRoot, name, destination, signal)
  const revision =
    from === undefined || from.length === 0
      ? '@'
      : await resolveFrom(host, workspaceRoot, from, signal)

  await host.prepare(projectRoot, poolPath, destination, signal)
  onPhase?.('checkout')
  try {
    await host.run(
      workspaceRoot,
      ['workspace', 'add', '--name', name, '-r', revision, '--', destination],
      signal,
    )
    await host.run(destination, ['bookmark', 'create', '-r', '@', '--', name], signal)
  } catch (error) {
    throw new Error(
      `Could not finish jj workspace ${name} at ${destination}. The workspace directory and task bookmark may be partially created; nothing was rolled back. ${messageOf(error)}`,
      { cause: error },
    )
  }

  const changeId = await readOne(host, destination, '@', 'change_id', signal)
  const baseChange = await readOne(host, destination, '@-', 'change_id', signal)
  const baseCommit = await readOne(host, destination, '@-', 'commit_id', signal)
  return {
    path: destination,
    workspace: name,
    bookmark: name,
    changeId,
    baseChange,
    baseCommit,
    repositoryRoot: projectRoot,
    poolPath,
  }
}

/** Build the durable record for one created workspace. */
export function jjTaskRecord(
  created: CreatedJjWorkspace,
  sessionId: string,
  origin: JjTaskOrigin,
): JjTaskRecord {
  return {
    version: 1,
    sessionId,
    projectRoot: created.repositoryRoot,
    workspace: created.workspace,
    path: created.path,
    bookmark: created.bookmark,
    changeId: created.changeId,
    baseChange: created.baseChange,
    baseCommit: created.baseCommit,
    origin,
    createdAt: new Date().toISOString(),
  }
}
