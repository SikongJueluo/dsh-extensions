import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
  readFile as readTextFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import { Config, default as JjWorktreeService } from './lib/index.js'
import { apply as applyTool } from './lib/tool.js'

let failures = 0
function check(label, condition) {
  if (condition) console.log('ok -', label)
  else {
    failures += 1
    console.error('FAIL -', label)
  }
}

/** The bounded captured bytes of one stubbed stream. */
function read(chunks) {
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), lossy: false })
}

const root = await mkdtemp(join(tmpdir(), 'jj-workspace-smoke-'))
const home = join(root, 'home')
const xdg = join(root, 'xdg')
await mkdir(home)
await mkdir(xdg)
const jjConfig = join(root, 'jj-config.toml')
await writeFile(
  jjConfig,
  'ui.color = "never"\nuser.name = "Test"\nuser.email = "test@example.com"\n',
)
process.env.HOME = home
process.env.XDG_CONFIG_HOME = xdg
process.env.JJ_CONFIG = jjConfig
process.env.JJ_USER = 'Test'
process.env.JJ_EMAIL = 'test@example.com'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' })
}

const { spawn } = await import('node:child_process')
const subprocess = {
  resolveExecutable: async (command) => command,
  spawn(spec) {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...spec.env }).filter(([, value]) => value !== undefined),
    )
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => {
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err.push(chunk)
    })
    const done = new Promise((resolveDone, reject) => {
      child.on('error', reject)
      child.on('close', (code, signal) => resolveDone({ exitCode: code, signal }))
    })
    return {
      done,
      collected: { stdout: { readFrom: read(out) }, stderr: { readFrom: read(err) } },
      terminate() {
        child.kill()
      },
      waitForExit: () => done.then(() => undefined),
    }
  },
}

function target(path) {
  return { key: path, targetKey: path }
}

const fsStub = {
  async resolve(path, opts = {}) {
    return target(resolvePath(opts.cwd ?? process.cwd(), path))
  },
  processPath(entry) {
    return entry.key
  },
  contains(parent, child) {
    const rel = relative(resolvePath(parent.key), resolvePath(child.key))
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
  },
  async lstat(path) {
    try {
      const info = await lstat(path)
      return {
        type: info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : info.isSymbolicLink()
              ? 'symlink'
              : 'other',
        version: 'v1',
      }
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  },
  async readText(entry) {
    try {
      return await readTextFile(entry.key, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new FsError(`missing ${entry.key}`, 'FS_NOT_FOUND', { cause: error })
      throw error
    }
  },
  async writeText(entry, content) {
    await writeFile(entry.key, content, 'utf8')
    return { version: 'v2' }
  },
}

let cwd = ''
const workingDirectory = {
  async ensure() {
    return cwd
  },
  get() {
    return cwd
  },
  async set(_agent, path) {
    cwd = path
    return path
  },
}

const sandbox = { confine: async (argv) => ({ argv }) }
const sandboxPolicy = {
  resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }),
}
const session = Session.create(SessionId('session-1'))
const sessions = { get: (id) => (id === 'session-1' ? session : undefined) }

const ctx = new Context()
ctx.provide('workingDirectory', workingDirectory)
ctx.provide('fs', fsStub)
ctx.provide('subprocess', subprocess)
ctx.provide('sandbox', sandbox)
ctx.provide('sandboxPolicy', sandboxPolicy)
ctx.provide('sessions', sessions)

const service = new JjWorktreeService(ctx, Config({}))
check('provider registers the worktrees service', ctx.get('worktrees') instanceof JjWorktreeService)
const agent = { session }

const jjRepo = join(root, 'jj-repo')
await mkdir(jjRepo)
execFileSync('jj', ['--no-pager', '--color=never', 'git', 'init', '--no-colocate'], {
  cwd: jjRepo,
  env: process.env,
})
await writeFile(join(jjRepo, 'a.txt'), 'one\n')
execFileSync('jj', ['--no-pager', '--color=never', 'describe', '-m', 'base'], {
  cwd: jjRepo,
  env: process.env,
})
execFileSync('jj', ['--no-pager', '--color=never', 'bookmark', 'create', 'base-bm', '-r', '@'], {
  cwd: jjRepo,
  env: process.env,
})
execFileSync('jj', ['--no-pager', '--color=never', 'new'], { cwd: jjRepo, env: process.env })
await writeFile(join(jjRepo, 'a.txt'), 'one\ntwo\n')
execFileSync('jj', ['--no-pager', '--color=never', 'describe', '-m', 'wip'], {
  cwd: jjRepo,
  env: process.env,
})

cwd = jjRepo
const created = await service.create(agent, { name: 'task', origin: 'tool' })
check('jj create reports vcs jj', created.vcs === 'jj')
check(
  'jj create returns the bookmark as branch',
  created.branch === 'task' && created.bookmark === 'task',
)
check('jj create enters the workspace', cwd === created.path)
const jjWorkspace = join(jjRepo, '.agents/workspaces/task')
check('jj workspace directory exists', (await lstat(jjWorkspace)).isDirectory())
check(
  'jj workspace has no Git checkout',
  (await fsStub.lstat(join(jjWorkspace, '.git'))) === undefined,
)
check(
  'jj workspace has the snapshotted file',
  (await readFile(join(jjWorkspace, 'a.txt'), 'utf8')) === 'one\ntwo\n',
)
check(
  'pool is self-ignoring',
  (await readFile(join(jjRepo, '.agents/workspaces/.gitignore'), 'utf8')) === '*\n',
)
const recordPath = join(jjRepo, '.agents/workspaces/.dsh-jj-workspace-records.jsonl')
const records = (await readFile(recordPath, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
check(
  'jj create appends one task record',
  records.length === 1 && records[0].workspace === 'task' && records[0].origin === 'tool',
)
check(
  'jj record has the bookmark and pinned base',
  records[0].bookmark === 'task' &&
    typeof records[0].baseChange === 'string' &&
    records[0].baseChange.length > 0,
)
const status = await service.status('session-1')
check(
  'status classifies the non-colocated jj project',
  status.kind === 'jj' && status.hasGit === false,
)
check('status reports no blocker under full access', status.blocker === null)
check(
  'status lists local bookmarks for the base menu',
  Array.isArray(status.bookmarks) &&
    status.bookmarks.includes('task') &&
    status.bookmarks.includes('base-bm'),
)
check('tasks reads the durable association', (await service.tasks(jjRepo)).length === 1)
const savedPolicy = sandboxPolicy.resolve
sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: cwd })
check(
  'status reports a read-only blocker',
  (await service.status('session-1')).blocker === 'read-only',
)
const otherWritable = join(root, 'other-writable')
await mkdir(otherWritable)
sandboxPolicy.resolve = () => ({ mode: 'workspace-write', workspaceRoot: otherWritable })
check(
  'status reports an outside-writable-root blocker',
  (await service.status('session-1')).blocker === 'outside-writable-root',
)
sandboxPolicy.resolve = savedPolicy

const initialStates = await service.taskStates('session-1')
check(
  'taskStates observes the created workspace and bookmark',
  initialStates.length === 1 && initialStates[0].state === 'ok',
)

let jjRestoreRefused = false
try {
  await service.restore(agent, {
    path: created.path,
    branch: created.branch,
    baseCommit: created.baseCommit,
    repositoryRoot: created.repositoryRoot,
  })
} catch (error) {
  jjRestoreRefused = /not supported/u.test(String(error))
}
check('jj restore is refused', jjRestoreRefused)

let toolDefinition
applyTool({
  tools: {
    register(definition) {
      toolDefinition = definition
      return () => {}
    },
  },
  worktrees: service,
})
check('tool registers create_worktree', toolDefinition.name === 'create_worktree')
check(
  'tool output requires vcs',
  toolDefinition.output.schema.required.includes('vcs') &&
    toolDefinition.output.schema.properties.vcs.enum.join(',') === 'git,jj',
)
check(
  'tool parameters stay name/from',
  Object.keys(toolDefinition.parameters.properties).toSorted().join(',') === 'from,name',
)
cwd = jjRepo
const toolResult = await toolDefinition.execute(
  { name: 'tool-task' },
  { agent, signal: new AbortController().signal },
)
check(
  'tool execution returns the jj workspace',
  toolResult.vcs === 'jj' &&
    toolResult.bookmark === 'tool-task' &&
    toolResult.branch === 'tool-task',
)
check('tool execution enters the workspace', cwd === toolResult.path)
check('tool execution appends its own record', (await service.tasks(jjRepo)).length === 2)

cwd = toolResult.path
const uiResult = await service.create(agent, { name: 'ui-task', origin: 'ui' })
check(
  'UI-origin creation uses the same provider',
  uiResult.vcs === 'jj' && uiResult.workspace === 'ui-task',
)
check('UI-origin creation appends its own record', (await service.tasks(jjRepo)).length === 3)
const uiRecords = (await service.tasks(jjRepo)).filter((record) => record.workspace === 'ui-task')
check('UI-origin record is marked as ui', uiRecords.length === 1 && uiRecords[0].origin === 'ui')

const before = await service.taskStates('session-1')
check(
  'taskStates unifies both creation entries',
  before.length === 3 && before.every((task) => task.state === 'ok'),
)

const remoteRepo = join(root, 'remote.git')
git(root, ['init', '--bare', '-q', remoteRepo])
execFileSync('jj', ['--no-pager', '--color=never', 'git', 'remote', 'add', 'origin', remoteRepo], {
  cwd: jjRepo,
  env: process.env,
})
execFileSync('jj', ['--no-pager', '--color=never', 'describe', '-m', 'task'], {
  cwd: toolResult.path,
  env: process.env,
})
execFileSync('jj', ['--no-pager', '--color=never', 'git', 'push', '-b', 'tool-task'], {
  cwd: toolResult.path,
  env: process.env,
})

execFileSync('jj', ['--no-pager', '--color=never', 'new', '-m', 'tip'], {
  cwd: toolResult.path,
  env: process.env,
})
execFileSync('jj', ['--no-pager', '--color=never', 'bookmark', 'move', 'tool-task', '--to', '@'], {
  cwd: toolResult.path,
  env: process.env,
})
execFileSync('jj', ['--no-pager', '--color=never', 'bookmark', 'delete', 'ui-task'], {
  cwd: uiResult.path,
  env: process.env,
})
const changed = await service.taskStates('session-1')
const moved = changed.find((task) => task.workspace === 'tool-task')
const missing = changed.find((task) => task.workspace === 'ui-task')
check(
  'taskStates reports a moved bookmark without moving it back',
  moved &&
    moved.state === 'moved' &&
    moved.currentChangeId !== undefined &&
    moved.currentChangeId !== moved.changeId,
)
check(
  'taskStates reports a deleted bookmark as missing',
  missing && missing.state === 'bookmark-missing',
)
check(
  'taskStates leaves the untouched task ok',
  changed.find((task) => task.workspace === 'task')?.state === 'ok',
)

execFileSync('jj', ['--no-pager', '--color=never', 'bookmark', 'delete', 'tool-task'], {
  cwd: toolResult.path,
  env: process.env,
})
const afterDelete = await service.taskStates('session-1')
check(
  'taskStates reports a local delete even with a tracked remote',
  afterDelete.find((task) => task.workspace === 'tool-task')?.state === 'bookmark-missing',
)
const statusAfterDelete = await service.status('session-1')
check(
  'status base menu keeps only local present bookmarks',
  Array.isArray(statusAfterDelete.bookmarks) && !statusAfterDelete.bookmarks.includes('tool-task'),
)

await rm(join(jjRepo, '.agents/workspaces/task'), { recursive: true, force: true })
const afterRemoval = await service.taskStates('session-1')
check(
  'taskStates checks the workspace directory, not only registration',
  afterRemoval.find((task) => task.workspace === 'task')?.state === 'workspace-missing',
)

const ctx2 = new Context()
ctx2.provide('workingDirectory', workingDirectory)
ctx2.provide('fs', fsStub)
ctx2.provide('subprocess', subprocess)
ctx2.provide('sandbox', sandbox)
ctx2.provide('sandboxPolicy', sandboxPolicy)
ctx2.provide('sessions', sessions)
const restarted = new JjWorktreeService(ctx2, Config({}))
const restartedStates = await restarted.taskStates('session-1')
check(
  'restart reads the same durable task states',
  restartedStates.length === 3 &&
    restartedStates.find((task) => task.workspace === 'tool-task')?.state === 'bookmark-missing' &&
    restartedStates.find((task) => task.workspace === 'ui-task')?.state === 'bookmark-missing' &&
    restartedStates.find((task) => task.workspace === 'task')?.state === 'workspace-missing',
)

const gitRepo = join(root, 'git-repo')
await mkdir(gitRepo)
git(gitRepo, ['init', '-q'])
git(gitRepo, ['config', 'user.name', 'Test'])
git(gitRepo, ['config', 'user.email', 'test@example.com'])
await writeFile(join(gitRepo, 'a.txt'), 'one\n')
git(gitRepo, ['add', 'a.txt'])
git(gitRepo, ['commit', '-qm', 'base'])

cwd = gitRepo
const gitCreated = await service.create(agent, { name: 'gittask' })
check(
  'Git create keeps the stock result',
  gitCreated.vcs === 'git' && gitCreated.branch === 'gittask',
)
check('Git create enters the checkout', cwd === gitCreated.path)
check(
  'Git checkout is a real worktree',
  git(gitCreated.path, ['rev-parse', '--show-toplevel']).trim() === gitCreated.path,
)
check('Git create wrote no jj record', (await service.tasks(gitRepo)).length === 0)

cwd = gitRepo
const gitStatus = await service.status('session-1')
check('status classifies a Git checkout', gitStatus.kind === 'git')

process.exitCode = failures === 0 ? 0 : 1
await rm(root, { recursive: true, force: true })
