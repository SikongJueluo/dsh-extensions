import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJjWorkspace,
  findVcsRoot,
  jjTaskRecord,
  serializeTaskRecord,
  taskRecordPath,
  validateWorkspaceName,
  type JjWorkspaceHost,
  type VcsProbe,
} from '../src/jj.js'

interface Fixture {
  root: string
  repo: string
  env: NodeJS.ProcessEnv
}

let fixture: Fixture

/** Run jj in one directory with the fixture's isolated config. */
function run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'jj',
      ['--no-pager', '--color=never', ...args],
      { cwd, env: fixture.env, signal, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${stderr.trim() || error.message}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** The plain-Node host adapter the integration test drives. */
function host(): JjWorkspaceHost {
  return {
    run: (cwd, args, signal) => run(cwd, args, signal),
    exists: async (path) => {
      try {
        await stat(path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    prepare: async (_projectRoot, poolPath, destination) => {
      await mkdir(dirname(poolPath), { recursive: true })
      let created = false
      try {
        await mkdir(poolPath)
        created = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (created) await writeFile(join(poolPath, '.gitignore'), '*\n', { flag: 'wx' })
      await mkdir(dirname(destination), { recursive: true })
      await mkdir(destination)
    },
  }
}

/** Read one template field of one revision. */
async function revisionValue(cwd: string, revision: string, field: string): Promise<string> {
  return (
    await run(cwd, [
      '--ignore-working-copy',
      'log',
      '-r',
      revision,
      '--no-graph',
      '-T',
      `${field} ++ "\\n"`,
    ])
  ).trim()
}

/** Read the change id a local bookmark points at, or undefined. */
async function bookmarkTarget(cwd: string, name: string): Promise<string | undefined> {
  const lines = (
    await run(cwd, [
      '--ignore-working-copy',
      'bookmark',
      'list',
      '-T',
      'name ++ " " ++ normal_target.change_id() ++ "\\n"',
    ])
  )
    .split('\n')
    .filter((line) => line.length > 0)
  const line = lines.find((candidate) => candidate.startsWith(`${name} `))
  return line?.slice(name.length + 1)
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'jj-workspace-test-'))
  const home = join(root, 'home')
  const configHome = join(root, 'xdg')
  await mkdir(home)
  await mkdir(configHome)
  const config = join(root, 'jj-config.toml')
  await writeFile(
    config,
    'ui.color = "never"\nuser.name = "Test"\nuser.email = "test@example.com"\n',
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    JJ_CONFIG: config,
    JJ_USER: 'Test',
    JJ_EMAIL: 'test@example.com',
    NO_COLOR: '1',
  }
  const repo = join(root, 'repo')
  await mkdir(repo)
  fixture = { root, repo, env }
  await run(repo, ['git', 'init', '--no-colocate'])
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await run(repo, ['describe', '-m', 'base'])
  await run(repo, ['bookmark', 'create', 'base-bm', '-r', '@'])
  await run(repo, ['new'])
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n')
})

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

describe('createJjWorkspace', () => {
  it('creates a workspace and a task bookmark from the snapshotted current change', async () => {
    const created = await createJjWorkspace(host(), {
      cwd: fixture.repo,
      name: 'task',
      poolDirectory: '.agents/workspaces',
      signal: new AbortController().signal,
    })

    expect(created.path).toBe(join(fixture.repo, '.agents/workspaces/task'))
    expect(created.repositoryRoot).toBe(fixture.repo)
    expect((await stat(join(created.path, '.jj'))).isDirectory()).toBe(true)
    expect(await readFile(join(created.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    await expect(stat(join(created.path, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })

    const newAt = await revisionValue(created.path, '@', 'change_id')
    const parent = await revisionValue(created.path, '@-', 'change_id')
    const sourceAt = await revisionValue(fixture.repo, '@', 'change_id')
    expect(created.changeId).toBe(newAt)
    expect(created.baseChange).toBe(parent)
    expect(parent).toBe(sourceAt)
    expect(created.baseCommit).toBe(await revisionValue(fixture.repo, '@', 'commit_id'))
    expect(await bookmarkTarget(created.path, 'task')).toBe(newAt)
    expect(await bookmarkTarget(fixture.repo, 'base-bm')).toBe(
      await revisionValue(fixture.repo, '@-', 'change_id'),
    )

    const record = jjTaskRecord(created, 'session-1', 'tool')
    expect(record).toMatchObject({
      version: 1,
      sessionId: 'session-1',
      projectRoot: fixture.repo,
      workspace: 'task',
      bookmark: 'task',
      changeId: newAt,
      baseChange: parent,
      origin: 'tool',
    })
    expect(serializeTaskRecord(record).endsWith('\n')).toBe(true)
    expect(taskRecordPath(fixture.repo, '.agents/workspaces')).toBe(
      join(fixture.repo, '.agents/workspaces/.dsh-jj-workspace-records.jsonl'),
    )
    expect((await stat(join(fixture.repo, '.agents/workspaces/.gitignore'))).isFile()).toBe(true)
  })

  it('defaults to the current change in a colocated repo even with Git HEAD attached', async () => {
    const repo = join(fixture.root, 'colocated')
    await mkdir(repo)
    execFileSync('jj', ['--no-pager', '--color=never', 'git', 'init', '--colocate'], {
      cwd: repo,
      env: fixture.env,
    })
    await writeFile(join(repo, 'a.txt'), 'one\n')
    execFileSync('jj', ['--no-pager', '--color=never', 'describe', '-m', 'base'], {
      cwd: repo,
      env: fixture.env,
    })
    execFileSync('jj', ['--no-pager', '--color=never', 'bookmark', 'create', 'main', '-r', '@'], {
      cwd: repo,
      env: fixture.env,
    })
    execFileSync('jj', ['--no-pager', '--color=never', 'new'], { cwd: repo, env: fixture.env })
    await writeFile(join(repo, 'a.txt'), 'one\ncurrent\n')
    // The reviewer's fixture: Git HEAD names the base branch, not a detached commit.
    execFileSync('git', ['--no-pager', 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: repo,
      env: fixture.env,
    })

    const sourceAt = await revisionValue(repo, '@', 'change_id')
    const created = await createJjWorkspace(host(), {
      cwd: repo,
      name: 'task',
      poolDirectory: '.agents/workspaces',
      signal: new AbortController().signal,
    })

    expect(created.baseChange).toBe(sourceAt)
    expect(created.baseCommit).toBe(await revisionValue(repo, '@', 'commit_id'))
    expect(await readFile(join(created.path, 'a.txt'), 'utf8')).toBe('one\ncurrent\n')
    expect(
      (await stat(join(created.path, '.git'))).isFile() ||
        (await stat(join(created.path, '.git'))).isDirectory(),
    ).toBe(true)
  })

  it('pins an explicit bookmark base without moving the source change', async () => {
    const base = await bookmarkTarget(fixture.repo, 'base-bm')
    const sourceAt = await revisionValue(fixture.repo, '@', 'change_id')

    const created = await createJjWorkspace(host(), {
      cwd: fixture.repo,
      name: 'from-base',
      from: 'base-bm',
      poolDirectory: '.agents/workspaces',
      signal: new AbortController().signal,
    })

    expect(created.baseChange).toBe(base)
    expect(await revisionValue(created.path, '@-', 'change_id')).toBe(base)
    expect(await revisionValue(fixture.repo, '@', 'change_id')).toBe(sourceAt)
    expect(await bookmarkTarget(created.path, 'from-base')).toBe(created.changeId)
  })

  it('creates nested directory names', async () => {
    const created = await createJjWorkspace(host(), {
      cwd: fixture.repo,
      name: 'feat/deep',
      poolDirectory: '.agents/workspaces',
      signal: new AbortController().signal,
    })
    expect(created.path).toBe(join(fixture.repo, '.agents/workspaces/feat/deep'))
    expect((await stat(created.path)).isDirectory()).toBe(true)
  })

  it('rejects an existing workspace name without touching the created workspace', async () => {
    const first = await createJjWorkspace(host(), {
      cwd: fixture.repo,
      name: 'task',
      poolDirectory: '.agents/workspaces',
      signal: new AbortController().signal,
    })

    await expect(
      createJjWorkspace(host(), {
        cwd: fixture.repo,
        name: 'task',
        poolDirectory: '.agents/workspaces',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/workspace already exists/)

    expect((await stat(first.path)).isDirectory()).toBe(true)
    expect(await bookmarkTarget(fixture.repo, 'task')).toBe(first.changeId)
  })

  it('rejects an existing bookmark name before allocating a workspace', async () => {
    await expect(
      createJjWorkspace(host(), {
        cwd: fixture.repo,
        name: 'base-bm',
        poolDirectory: '.agents/workspaces',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/bookmark already exists/)
    await expect(stat(join(fixture.repo, '.agents/workspaces/base-bm'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('findVcsRoot', () => {
  const probe: VcsProbe = {
    lstat: async (path) => {
      try {
        const info = await stat(path)
        return { type: info.isDirectory() ? 'directory' : 'file' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }

  it('prefers a nested Git worktree over an outer jj workspace', async () => {
    const outer = join(fixture.root, 'outer')
    await mkdir(join(outer, '.jj'), { recursive: true })
    const worktree = join(outer, 'worktree')
    await mkdir(worktree)
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere\n')
    expect(await findVcsRoot(worktree, probe)).toEqual({ root: worktree, jj: false })
  })

  it('finds the enclosing jj workspace from a subdirectory', async () => {
    const outer = join(fixture.root, 'jj-outer')
    await mkdir(join(outer, '.jj'), { recursive: true })
    const sub = join(outer, 'src', 'nested')
    await mkdir(sub, { recursive: true })
    expect(await findVcsRoot(sub, probe)).toEqual({ root: outer, jj: true })
  })

  it('treats a colocated workspace as jj', async () => {
    const outer = join(fixture.root, 'colocated')
    await mkdir(join(outer, '.jj'), { recursive: true })
    await mkdir(join(outer, '.git'))
    expect(await findVcsRoot(outer, probe)).toEqual({ root: outer, jj: true })
  })

  it('reports no VCS root outside a repository', async () => {
    expect(await findVcsRoot(fixture.root, probe)).toBeUndefined()
  })
})

describe('validateWorkspaceName', () => {
  it('accepts generated and nested names', () => {
    expect(validateWorkspaceName('dsh-1234abcd-1a2b')).toBeUndefined()
    expect(validateWorkspaceName('feat/deep-task')).toBeUndefined()
  })

  it('rejects path traversal, empty segments, and unsafe characters', () => {
    for (const name of [
      '',
      '-task',
      'a//b',
      'a/../b',
      '.',
      '..',
      'a b',
      'a\\b',
      'a:b',
      '/abs',
      'a..b',
      'a.',
      'a.lock',
    ]) {
      expect(validateWorkspaceName(name), name).toBeTypeOf('string')
    }
  })
})
