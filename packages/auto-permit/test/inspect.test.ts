/**
 * Read-only evidence boundary tests: the judge may read the project and
 * nothing else, and every capability is enforced by the module rather than by
 * prompt wording.
 *
 * @module dsh-auto-permit/inspect.test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSPECT_LIMITS, createInspector } from '../src/inspect.js'
import type { Inspector } from '../src/inspect.js'

let root: string
let outside: string
let inspector: Inspector

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-inspect-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-outside-'))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'scripts', 'build.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'podman build -t local/app:test .',
    'podman run --rm -v "$PWD:/src:ro" local/app:test check',
  ].join('\n'))
  await writeFile(join(root, 'src', 'app.py'), 'def main():\n    print("hello")\n')
  await writeFile(join(root, '.env'), 'SECRET=do-not-read\n')
  await writeFile(join(root, '.env.example'), 'EXAMPLE=public\n')
  await writeFile(join(root, '.git', 'config'), '[remote "origin"]\n')
  await writeFile(join(outside, 'secret.txt'), 'outside-token-xyz\n')
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
})

beforeEach(async () => {
  inspector = (await createInspector(root, root)) as Inspector
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('read_file', () => {
  it('returns bounded line-numbered text', async () => {
    const result = await inspector.execute('read_file', JSON.stringify({ path: 'scripts/build.sh' }))
    expect(result.isError).toBe(false)
    expect(result.text).toContain('1: #!/usr/bin/env bash')
    expect(result.text).toContain('3: podman build -t local/app:test .')
    expect(inspector.references()).toContain('scripts/build.sh:1-4')
  })

  it('honours offset and limit', async () => {
    const result = await inspector.execute('read_file', JSON.stringify({ path: 'scripts/build.sh', offset: 3, limit: 1 }))
    expect(result.text).toBe('3: podman build -t local/app:test .')
  })

  it('rejects a path outside the workspace', async () => {
    const result = await inspector.execute('read_file', JSON.stringify({ path: join(outside, 'secret.txt') }))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside the session workspace')
  })

  it('rejects a symlink that resolves outside the workspace', async () => {
    const result = await inspector.execute('read_file', JSON.stringify({ path: 'escape.txt' }))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside the session workspace')
  })

  it('never returns secret-looking files or VCS internals', async () => {
    const env = await inspector.execute('read_file', JSON.stringify({ path: '.env' }))
    expect(env.isError).toBe(true)
    expect(env.text).toContain('not readable')
    const git = await inspector.execute('read_file', JSON.stringify({ path: '.git/config' }))
    expect(git.isError).toBe(true)
    const example = await inspector.execute('read_file', JSON.stringify({ path: '.env.example' }))
    expect(example.isError).toBe(false)
    expect(example.text).toContain('EXAMPLE=public')
  })

  it('does not invent a line range when one line exceeds the read budget', async () => {
    const longLine = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-longline-'))
    try {
      await writeFile(join(longLine, 'long.txt'), `${'x'.repeat(INSPECT_LIMITS.maxReadBytes + 100)}\n`)
      const scoped = await createInspector(longLine, longLine) as Inspector
      const result = await scoped.execute('read_file', JSON.stringify({ path: 'long.txt' }))
      expect(result.isError).toBe(false)
      expect(result.incomplete).toBe(true)
      expect(result.text).toContain('truncated')
      expect(scoped.references().at(-1)).toBe('long.txt:1')
      expect(scoped.problem()?.category).toBe('budget')
    } finally {
      await rm(longLine, { recursive: true, force: true })
    }
  })

  it('reports a missing file instead of guessing', async () => {
    const result = await inspector.execute('read_file', JSON.stringify({ path: 'missing.sh' }))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unavailable')
  })
})

describe('list_dir', () => {
  it('lists entries with kinds and sizes', async () => {
    const result = await inspector.execute('list_dir', JSON.stringify({ path: '.' }))
    expect(result.isError).toBe(false)
    expect(result.text).toContain('dir  scripts/')
    expect(result.text).toContain('link escape.txt')
    expect(result.text).not.toContain('file .env ')
    expect(result.text).toContain('file .env.example')
    expect(result.text).not.toContain('.git')
  })

  it('does not list through a symlink', async () => {
    const result = await inspector.execute('list_dir', JSON.stringify({ path: 'escape.txt' }))
    expect(result.isError).toBe(true)
  })
})

describe('search_files', () => {
  it('finds literal text with file and line references', async () => {
    const result = await inspector.execute('search_files', JSON.stringify({ text: 'podman run --rm' }))
    expect(result.isError).toBe(false)
    expect(result.text).toContain('scripts/build.sh:4:')
    expect(inspector.references()).toContain('scripts/build.sh:4')
  })

  it('never searches denied or escaping files', async () => {
    const env = await inspector.execute('search_files', JSON.stringify({ text: 'SECRET' }))
    expect(env.text).not.toContain('do-not-read')
    const escaped = await inspector.execute('search_files', JSON.stringify({ text: 'outside-token-xyz' }))
    expect(escaped.text).not.toContain('escape.txt')
  })

  it('reports no matches explicitly', async () => {
    const result = await inspector.execute('search_files', JSON.stringify({ text: 'not-present-anywhere' }))
    expect(result.text).toContain('no matches')
  })
})

describe('bounds and versions', () => {
  it('stops after the tool-call budget', async () => {
    const budget = await createInspector(root, root) as Inspector
    let last
    for (let i = 0; i < INSPECT_LIMITS.maxToolCalls; i += 1) {
      last = await budget.execute('read_file', JSON.stringify({ path: 'src/app.py' }))
      expect(last.isError).toBe(false)
    }
    last = await budget.execute('read_file', JSON.stringify({ path: 'src/app.py' }))
    expect(last.isError).toBe(true)
    expect(last.incomplete).toBe(true)
    expect(last.text).toContain('tool budget exhausted')
    expect(budget.problem()?.category).toBe('budget')
  })

  it('refuses a result that would cross the total output budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-output-'))
    try {
      const body = `${'a'.repeat(180)}\n`.repeat(70)
      for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(dir, name), body)
      const scoped = await createInspector(dir, dir) as Inspector
      let returned = 0
      let lastError = false
      for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        const result = await scoped.execute('read_file', JSON.stringify({ path: name }))
        if (result.isError) lastError = true
        else returned += Buffer.byteLength(result.text, 'utf8')
        if (result.incomplete) expect(scoped.problem()?.category).toBe('budget')
      }
      expect(lastError).toBe(true)
      expect(returned).toBeLessThanOrEqual(INSPECT_LIMITS.maxOutputBytes)
      expect(scoped.problem()?.category).toBe('budget')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a too-large explicit search file instead of clipping matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-big-'))
    try {
      await writeFile(join(dir, 'big.txt'), 'needle\n' + 'x'.repeat(300 * 1024))
      const scoped = await createInspector(dir, dir) as Inspector
      const result = await scoped.execute('search_files', JSON.stringify({ text: 'needle', path: 'big.txt' }))
      expect(result.isError).toBe(true)
      expect(result.text).toContain('too large')
      expect(scoped.problem()?.category).toBe('budget')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a binary explicit search file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-bin-'))
    try {
      await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 4]))
      const scoped = await createInspector(dir, dir) as Inspector
      const result = await scoped.execute('search_files', JSON.stringify({ text: 'x', path: 'bin.dat' }))
      expect(result.isError).toBe(true)
      expect(result.text).toContain('not a UTF-8')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a FIFO instead of opening it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-fifo-'))
    try {
      execFileSync('mkfifo', [join(dir, 'pipe')])
      const scoped = await createInspector(dir, dir) as Inspector
      const read = await scoped.execute('read_file', JSON.stringify({ path: 'pipe' }))
      expect(read.isError).toBe(true)
      expect(read.text).toContain('not a regular file')
      const search = await scoped.execute('search_files', JSON.stringify({ text: 'x', path: 'pipe' }))
      expect(search.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('invalidates the turn when a file changes between two reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-version-'))
    try {
      const file = join(dir, 'build.sh')
      await writeFile(file, 'echo safe\necho second\n')
      const scoped = await createInspector(dir, dir) as Inspector
      expect((await scoped.execute('read_file', JSON.stringify({ path: 'build.sh', limit: 1 }))).isError).toBe(false)
      await writeFile(file, 'podman run --privileged -v /:/host alpine\necho second\n')
      const second = await scoped.execute('read_file', JSON.stringify({ path: 'build.sh', offset: 2 }))
      expect(second.isError).toBe(true)
      expect(second.incomplete).toBe(true)
      expect(second.text).toContain('changed')
      expect(scoped.invalidated()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('detects a symlinked entry retargeted after it was read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-link-'))
    try {
      await writeFile(join(dir, 'safe.sh'), 'echo safe\n')
      await writeFile(join(dir, 'bad.sh'), 'podman run --privileged -v /:/host alpine\n')
      await symlink(join(dir, 'safe.sh'), join(dir, 'entry.sh'))
      const scoped = await createInspector(dir, dir) as Inspector
      const read = await scoped.execute('read_file', JSON.stringify({ path: 'entry.sh' }))
      expect(read.isError).toBe(false)
      expect(scoped.references().some((ref) => ref.startsWith('entry.sh:'))).toBe(true)
      await rm(join(dir, 'entry.sh'))
      await symlink(join(dir, 'bad.sh'), join(dir, 'entry.sh'))
      expect(await scoped.changedFiles()).toContain('entry.sh')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports files whose content changed after being read', async () => {
    const changing = await createInspector(root, root) as Inspector
    await changing.execute('read_file', JSON.stringify({ path: 'src/app.py' }))
    expect(await changing.changedFiles()).toEqual([])
    await writeFile(join(root, 'src', 'app.py'), 'def main():\n    print("changed!")\n')
    expect(await changing.changedFiles()).toEqual(['src/app.py'])
  })

  it('throws on an already-aborted signal instead of reading', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(createInspector(root, root, controller.signal)).rejects.toThrow()
  })
})


describe('policy exclusions are not truncation', () => {
  it('lists a normal project root containing .git, .env, and node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-normal-'))
    try {
      await mkdir(join(dir, '.git'))
      await mkdir(join(dir, 'node_modules'))
      await mkdir(join(dir, 'scripts'))
      await writeFile(join(dir, '.env'), 'SECRET=x\n')
      await writeFile(join(dir, 'scripts', 'build.sh'), 'podman build .\n')
      const scoped = await createInspector(dir, dir) as Inspector
      const listed = await scoped.execute('list_dir', JSON.stringify({ path: '.' }))
      expect(listed.isError).toBe(false)
      expect(listed.incomplete).toBeUndefined()
      expect(listed.text).not.toContain('more entries omitted')
      expect(listed.text).toContain('scripts/')
      expect(scoped.problem()).toBeUndefined()
      const read = await scoped.execute('read_file', JSON.stringify({ path: 'scripts/build.sh' }))
      expect(read.isError).toBe(false)
      expect(scoped.problem()).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still gates a genuine list cut above the visible-entry cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-many-'))
    try {
      for (let i = 0; i < INSPECT_LIMITS.maxListEntries + 1; i += 1) {
        await writeFile(join(dir, `file-${String(i).padStart(3, '0')}.txt`), 'x\n')
      }
      const scoped = await createInspector(dir, dir) as Inspector
      const listed = await scoped.execute('list_dir', JSON.stringify({ path: '.' }))
      expect(listed.incomplete).toBe(true)
      expect(listed.text).toContain('more entries omitted')
      expect(scoped.problem()?.category).toBe('budget')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('truncated match lines are incomplete evidence', () => {
  it('marks an explicit single-file search whose matched line was clipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-line-'))
    try {
      const line = 'podman run --rm --label note=' + 'x'.repeat(400)
        + ' --privileged -v /:/host alpine true'
      await writeFile(join(dir, 'long.sh'), `${line}\n`)
      const scoped = await createInspector(dir, dir) as Inspector
      const result = await scoped.execute('search_files', JSON.stringify({ text: 'podman', path: 'long.sh' }))
      expect(result.isError).toBe(false)
      expect(result.incomplete).toBe(true)
      expect(result.text).not.toContain('privileged')
      expect(result.text).toContain('matched lines were truncated')
      expect(scoped.problem()?.category).toBe('budget')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('marks a recursive search whose matched line was clipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-permit-line-dir-'))
    try {
      const line = 'podman run --rm --label note=' + 'x'.repeat(400)
        + ' --privileged -v /:/host alpine true'
      await writeFile(join(dir, 'long.sh'), `${line}\n`)
      const scoped = await createInspector(dir, dir) as Inspector
      const result = await scoped.execute('search_files', JSON.stringify({ text: 'podman' }))
      expect(result.isError).toBe(false)
      expect(result.incomplete).toBe(true)
      expect(result.text).toContain('matched lines were truncated')
      expect(scoped.problem()?.category).toBe('budget')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
