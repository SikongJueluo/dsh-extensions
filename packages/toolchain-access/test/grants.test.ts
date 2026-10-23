/**
 * Grant-plan unit tests: pure `resolveGrants` over a fake filesystem, one
 * behavioral fact per case — default derivation, operator-statement trust,
 * every fail-closed floor, and the dedupe/workspace subtraction rules.
 *
 * @module dsh-toolchain-access/grants.test
 */
import { describe, expect, it } from 'vitest'
import {
  defaultBaseTrees,
  pathCovers,
  resolveGrants,
  type GrantEnv,
  type GrantFs,
  type GrantOverrides,
  type PresetId,
} from '../src/grants.js'

interface Entry {
  /** Symlink target (resolved by realpath); absent for real paths. */
  target?: string
  dir?: boolean
  file?: boolean
  uid?: number
  mode?: number
}

/** Deterministic in-memory fs over ONE table the test (and its ensure) mutates. */
function fakeFs(table: Record<string, Entry>): GrantFs {
  const stat = (path: string) => {
    const entry = table[path]
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    return {
      isDirectory: entry.dir ?? false,
      isFile: entry.file ?? false,
      uid: entry.uid ?? 1000,
      mode: entry.mode ?? 0o755,
    }
  }
  return {
    stat,
    realpath: (path: string): string => {
      let current = path
      for (let hop = 0; hop < 16; hop += 1) {
        const entry = table[current]
        if (entry === undefined) throw new Error(`ENOENT: ${current}`)
        if (entry.target === undefined) return current
        current = entry.target
      }
      throw new Error('symlink cycle')
    },
  }
}

const ENV: GrantEnv = {
  home: '/home/u',
  uid: 1000,
  xdgRuntimeDir: '/run/user/1000',
}

/** Resolve with only the paths the test cares about filled in. */
function plan(
  presets: readonly PresetId[],
  entries: Record<string, Entry>,
  extra: {
    overrides?: GrantOverrides
    env?: Partial<GrantEnv>
    workspaceRoots?: readonly string[]
    prepare?: boolean
  } = {},
) {
  const table: Record<string, Entry> = { '/': { dir: true }, ...entries }
  const ensured: Array<{ path: string; kind: string }> = []
  const fs: GrantFs = fakeFs(table)
  fs.ensure = (path, kind) => {
    ensured.push({ path, kind })
    table[path] = kind === 'lock-file' ? { file: true, mode: 0o644 } : { dir: true, mode: kind === 'lock-dir' ? 0o700 : 0o755 }
  }
  const result = resolveGrants({
    presets,
    overrides: extra.overrides ?? {},
    env: { ...ENV, ...extra.env },
    workspaceRoots: extra.workspaceRoots ?? [],
    fs,
    prepare: extra.prepare,
  })
  return { ...result, ensured }
}

const dir = (overrides: Entry = {}): Entry => ({ dir: true, ...overrides })

describe('default derivation', () => {
  it('derives every preset from HOME/XDG defaults', () => {
    const result = plan(
      ['uv-cache', 'cargo-cache', 'pnpm-store', 'pnpm-runtime-locks', 'pnpm-engine'],
      {
        '/home/u/.cache/uv': dir(),
        '/home/u/.cargo/registry': dir(),
        '/home/u/.cargo/git': dir(),
        '/home/u/.cargo/.package-cache': { file: true, mode: 0o644 },
        '/home/u/.cargo/.package-cache-mutate': { file: true, mode: 0o644 },
        '/home/u/.cargo/.global-cache': { file: true, mode: 0o644 },
        '/home/u/.local/share/pnpm/store': dir(),
        '/home/u/.local/share/pnpm': dir(),
        '/run/user/1000': { dir: true, mode: 0o700 },
        '/run/user/1000/pnpm-store-operation-locks-1000': { dir: true, mode: 0o700 },
      },
    )
    expect(result.issues).toEqual([])
    // pnpm-engine's whole-home bind absorbs pnpm-store's <home>/store
    // (dedupe is order-independent); output keeps derivation order, where
    // pnpm-runtime-locks precedes pnpm-engine in the presets array.
    expect(result.binds.map((bind) => bind.source)).toEqual([
      '/home/u/.cache/uv',
      '/home/u/.cargo/registry',
      '/home/u/.cargo/git',
      '/home/u/.cargo/.package-cache',
      '/home/u/.cargo/.package-cache-mutate',
      '/home/u/.cargo/.global-cache',
      '/run/user/1000/pnpm-store-operation-locks-1000',
      '/home/u/.local/share/pnpm',
    ])
  })

  it('honors exported anchors (CARGO_HOME, PNPM_HOME, XDG_*) even outside HOME', () => {
    const result = plan(
      ['cargo-cache', 'pnpm-store'],
      {
        '/data/cargo/registry': dir(),
        '/data/cargo/git': dir(),
        '/data/cargo/.package-cache': { file: true, mode: 0o644 },
        '/data/cargo/.package-cache-mutate': { file: true, mode: 0o644 },
        '/data/cargo/.global-cache': { file: true, mode: 0o644 },
        '/data/pnpm/store': dir(),
      },
      { env: { cargoHome: '/data/cargo', pnpmHome: '/data/pnpm' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual([
      '/data/cargo/registry',
      '/data/cargo/git',
      '/data/cargo/.package-cache',
      '/data/cargo/.package-cache-mutate',
      '/data/cargo/.global-cache',
      '/data/pnpm/store',
    ])
  })

  it('real filesystem: symlinked runtime root, first initialization is not misrefused', async () => {
    // XDG_RUNTIME_DIR is a symlink and pnpm's lock dir does not exist yet:
    // the first confine must create it and produce the CANONICAL bind
    // (realpath(runtime root) + lock name), not report lock-dir-mismatch
    // against the pre-creation spelling. The fixture lives under the
    // workspace (not os.tmpdir): host /tmp is a floor prefix by design.
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync, statSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { nodeGrantFs, resolveGrants: resolve } = await import('../src/index.js')
    const workspace = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const root = mkdtempSync(join(workspace, '.tca-runtime-'))
    try {
      const realRuntime = join(root, 'real-runtime')
      mkdirSync(realRuntime, { recursive: true, mode: 0o700 })
      symlinkSync(realRuntime, join(root, 'link-runtime'))
      const lockName = `pnpm-store-operation-locks-${process.getuid?.() ?? 1000}`
      const env = { home: join(root, 'home'), uid: process.getuid?.() ?? -1, xdgRuntimeDir: join(root, 'link-runtime') }
      const first = resolve({
        presets: ['pnpm-runtime-locks'],
        overrides: {},
        env,
        workspaceRoots: [],
        fs: nodeGrantFs(),
        prepare: true,
      })
      expect(first.issues).toEqual([])
      expect(first.binds.map((bind) => bind.source)).toEqual([join(realRuntime, lockName)])
      // Created inside the REAL runtime root, 0700, on the first call.
      const stats = statSync(join(realRuntime, lockName))
      expect(stats.isDirectory()).toBe(true)
      expect(stats.mode & 0o777).toBe(0o700)
      // Second call (dir now exists) resolves identically.
      const again = resolve({
        presets: ['pnpm-runtime-locks'],
        overrides: {},
        env,
        workspaceRoots: [],
        fs: nodeGrantFs(),
      })
      expect(again.issues).toEqual([])
      expect(again.binds.map((bind) => bind.source)).toEqual([join(realRuntime, lockName)])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses pnpm-runtime-locks without XDG_RUNTIME_DIR (shared lock domain would split)', () => {
    const result = plan(['pnpm-runtime-locks'], {}, { env: { xdgRuntimeDir: undefined } })
    expect(result.binds).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe('runtime-dir-unset')
  })

  it('an explicit lock-dir override does NOT skip the runtime-root validation', () => {
    // pnpm picks its lock dir from $XDG_RUNTIME_DIR regardless of what this
    // plugin configures: an override cannot rescue an invalid runtime root
    // (pnpm would still lock a private sandbox /tmp).
    const groupWritable = plan(
      ['pnpm-runtime-locks'],
      {
        '/run/user/1000': { dir: true, mode: 0o775 },
        '/run/user/1000/pnpm-store-operation-locks-1000': { dir: true, mode: 0o700 },
      },
      { overrides: { pnpmRuntimeLocks: '/run/user/1000/pnpm-store-operation-locks-1000' } },
    )
    expect(groupWritable.binds).toEqual([])
    expect(groupWritable.issues[0]?.reason).toBe('runtime-dir-unwritable')

    const unset = plan(
      ['pnpm-runtime-locks'],
      { '/data/my-locks': dir() },
      { env: { xdgRuntimeDir: undefined }, overrides: { pnpmRuntimeLocks: '/data/my-locks' } },
    )
    expect(unset.binds).toEqual([])
    expect(unset.issues[0]?.reason).toBe('runtime-dir-unset')
  })

  it('an explicit lock-dir override must BE the dir pnpm actually locks', () => {
    const standard = {
      '/run/user/1000': { dir: true, mode: 0o700 },
      '/run/user/1000/pnpm-store-operation-locks-1000': { dir: true, mode: 0o700 },
    } as const
    // Re-spelling pnpm's own lock dir: fine.
    const sameDir = plan(['pnpm-runtime-locks'], { ...standard }, {
      overrides: { pnpmRuntimeLocks: '/run/user/1000/pnpm-store-operation-locks-1000' },
    })
    expect(sameDir.issues).toEqual([])
    expect(sameDir.binds.map((bind) => bind.source)).toEqual(['/run/user/1000/pnpm-store-operation-locks-1000'])

    // Relocating it: pnpm cannot be redirected, so the grant is refused.
    const relocated = plan(['pnpm-runtime-locks'], { ...standard, '/data/my-locks': dir() }, {
      overrides: { pnpmRuntimeLocks: '/data/my-locks' },
    })
    expect(relocated.binds).toEqual([])
    expect(relocated.issues[0]?.reason).toBe('lock-dir-mismatch')
    expect(relocated.issues[0]?.message).toContain('/run/user/1000/pnpm-store-operation-locks-1000')
  })
})

describe('fail-closed validation', () => {
  it('reports a missing path with the preset named', () => {
    const result = plan(['uv-cache'], {})
    expect(result.binds).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe('missing')
    expect(result.issues[0]?.message).toContain('uv-cache')
    expect(result.issues[0]?.message).toContain('/home/u/.cache/uv')
  })

  it('refuses foreign-owned paths', () => {
    const result = plan(['uv-cache'], { '/home/u/.cache/uv': dir({ uid: 0 }) })
    expect(result.issues[0]?.reason).toBe('not-owner')
  })

  it('refuses group- and world-writable paths', () => {
    const groupWritable = plan(['uv-cache'], { '/home/u/.cache/uv': dir({ mode: 0o770 }) })
    expect(groupWritable.issues[0]?.reason).toBe('group-or-world-writable')
    const worldWritable = plan(['uv-cache'], { '/home/u/.cache/uv': dir({ mode: 0o777 }) })
    expect(worldWritable.issues[0]?.reason).toBe('group-or-world-writable')
  })

  it('refuses floor roots through symlink targets', () => {
    const result = plan(
      ['uv-cache'],
      { '/home/u/.cache/uv': { target: '/etc/uv' }, '/etc/uv': dir() },
    )
    expect(result.issues[0]?.reason).toBe('floor-path')
  })

  it('refuses the runtime-dir root itself (session sockets live there)', () => {
    const result = plan(
      ['pnpm-runtime-locks'],
      { '/run/user/1000': { dir: true, mode: 0o700 } },
      { overrides: { pnpmRuntimeLocks: '/run/user/1000' } },
    )
    expect(result.issues[0]?.reason).toBe('floor-path')
  })

  it('refuses the home directory itself, even explicitly configured', () => {
    const result = plan(['uv-cache'], { '/home/u': dir() }, { overrides: { uvCache: '/home/u' } })
    expect(result.issues[0]?.reason).toBe('floor-path')
  })

  it('refuses the WHOLE home through a symlinked HOME spelling (P1 regression)', () => {
    // HOME=/home/link -> /data/u; an explicit grant naming the home SPELLING
    // resolves to the whole /data/u — the canonical-home floor must refuse
    // it instead of binding every file under HOME (including .ssh/.config).
    const table: Record<string, Entry> = {
      '/': { dir: true },
      '/home/link': { target: '/data/u' },
      '/data/u': { dir: true },
    }
    const result = resolveGrants({
      presets: ['uv-cache'],
      overrides: { uvCache: '/home/link' },
      env: { ...ENV, home: '/home/link' },
      workspaceRoots: [],
      fs: fakeFs(table),
    })
    expect(result.binds).toEqual([])
    expect(result.issues[0]?.reason).toBe('floor-path')
    expect(result.issues[0]?.message).toContain('home directory itself')
  })

  it('real filesystem: symlinked HOME cannot be granted whole (reviewer fixture)', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { nodeGrantFs, resolveGrants: resolve } = await import('../src/index.js')
    const root = mkdtempSync(join(tmpdir(), 'tca-home-'))
    try {
      const actual = join(root, 'actual-home')
      mkdirSync(actual, { recursive: true })
      symlinkSync(actual, join(root, 'home-link'))
      const result = resolve({
        presets: ['uv-cache'],
        overrides: { uvCache: join(root, 'home-link') },
        env: { home: join(root, 'home-link'), uid: process.getuid?.() ?? -1 },
        workspaceRoots: [],
        fs: nodeGrantFs(),
      })
      expect(result.binds).toEqual([])
      expect(result.issues[0]?.reason).toBe('floor-path')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses credential and token trees, including via symlinks and runtime-dir spellings', () => {
    const direct = plan(
      ['uv-cache'],
      { '/home/u/.netrc': { file: true, mode: 0o600 } },
      { overrides: { uvCache: '/home/u/.netrc' } },
    )
    expect(direct.issues[0]?.reason).toBe('credential-segment')

    const linked = plan(
      ['uv-cache'],
      {
        '/home/u/.cache/uv': { target: '/home/u/.ssh/uv' },
        '/home/u/.ssh/uv': { dir: true },
      },
    )
    expect(linked.issues[0]?.reason).toBe('credential-segment')

    for (const path of ['/home/u/.git-credentials', '/home/u/.npmrc', '/run/user/1000/gnupg']) {
      const table: Record<string, Entry> = {
        '/home/u/.git-credentials': { file: true, mode: 0o600 },
        '/home/u/.npmrc': { file: true, mode: 0o600 },
        '/run/user/1000/gnupg': { dir: true, mode: 0o700 },
      }
      const result = resolveGrants({
        presets: ['uv-cache'],
        overrides: { uvCache: path },
        env: ENV,
        workspaceRoots: [],
        fs: fakeFs(table),
      })
      expect(result.issues[0]?.reason, path).toBe('credential-segment')
    }
  })

  it('binds the canonical target, not the spelling, for symlinked grants', () => {
    const result = plan(
      ['uv-cache'],
      {
        '/data/uv-real': dir(),
        '/home/u/.cache/uv': { target: '/data/uv-real' },
      },
      { overrides: { uvCache: '/home/u/.cache/uv' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds).toEqual([
      { source: '/data/uv-real', destination: '/data/uv-real', preset: 'uv-cache' },
    ])
  })

  it('rejects paths the owner cannot write (a grant must keep the tool working)', () => {
    const dirResult = plan(['uv-cache'], { '/home/u/.cache/uv': dir({ mode: 0o555 }) })
    expect(dirResult.issues[0]?.reason).toBe('not-owner-writable')
    const fileResult = plan(
      ['cargo-cache'],
      {
        '/home/u/.cargo/registry': dir(),
        '/home/u/.cargo/git': dir(),
        '/home/u/.cargo/.package-cache': { file: true, mode: 0o444 },
        '/home/u/.cargo/.package-cache-mutate': { file: true, mode: 0o644 },
        '/home/u/.cargo/.global-cache': { file: true, mode: 0o644 },
      },
    )
    expect(fileResult.issues[0]?.reason).toBe('not-owner-writable')
  })

  it('refuses pnpm-runtime-locks when the runtime dir fails pnpm\'s own conditions', () => {
    // pnpm 12.8.2+ falls back to /tmp for locks unless $XDG_RUNTIME_DIR is
    // a directory of this uid that the owner can write AND search, with
    // group/other write bits clear — the bind must cover the lock domain
    // pnpm actually uses, not merely a directory that exists.
    const groupWritable = plan(
      ['pnpm-runtime-locks'],
      {
        '/run/user/1000': { dir: true, mode: 0o775 },
        '/run/user/1000/pnpm-store-operation-locks-1000': { dir: true, mode: 0o700 },
      },
    )
    expect(groupWritable.binds).toEqual([])
    expect(groupWritable.issues[0]?.reason).toBe('runtime-dir-unwritable')

    const notSearchable = plan(
      ['pnpm-runtime-locks'],
      { '/run/user/1000': { dir: true, mode: 0o600 } },
    )
    expect(notSearchable.issues[0]?.reason).toBe('runtime-dir-unwritable')

    const foreign = plan(
      ['pnpm-runtime-locks'],
      { '/run/user/1000': { dir: true, mode: 0o700, uid: 0 } },
    )
    expect(foreign.issues[0]?.reason).toBe('runtime-dir-unwritable')

    // The standard systemd layout passes.
    const standard = plan(
      ['pnpm-runtime-locks'],
      {
        '/run/user/1000': { dir: true, mode: 0o700 },
        '/run/user/1000/pnpm-store-operation-locks-1000': { dir: true, mode: 0o700 },
      },
    )
    expect(standard.issues).toEqual([])
    expect(standard.binds.map((bind) => bind.source)).toEqual(['/run/user/1000/pnpm-store-operation-locks-1000'])
  })

  it('a HOME with a trailing slash or a symlinked HOME still derives defaults', () => {
    const trailing = plan(['uv-cache'], { '/home/u/.cache/uv': dir() }, { env: { home: '/home/u/' } })
    expect(trailing.issues).toEqual([])
    expect(trailing.binds.map((bind) => bind.source)).toEqual(['/home/u/.cache/uv'])

    const symlinked = resolveGrants({
      presets: ['uv-cache'],
      overrides: {},
      env: { ...ENV, home: '/home/link' },
      workspaceRoots: [],
      fs: fakeFs({
        '/': { dir: true },
        '/home/link': { target: '/data/u' },
        '/home/link/.cache': { target: '/data/u/.cache' },
        '/home/link/.cache/uv': { target: '/data/u/.cache/uv' },
        '/data/u/.cache': { dir: true },
        '/data/u/.cache/uv': { dir: true },
      }),
    })
    expect(symlinked.issues).toEqual([])
    expect(symlinked.binds.map((bind) => bind.source)).toEqual(['/data/u/.cache/uv'])
  })

  it('one bad preset poisons the whole plan (no partial grants)', () => {
    const result = plan(
      ['uv-cache', 'cargo-cache'],
      {
        '/home/u/.cache/uv': dir(),
        '/home/u/.cargo/registry': dir(),
        '/home/u/.cargo/git': dir(),
        // .package-cache* files missing entirely and prepare not requested
      },
    )
    expect(result.binds).toEqual([])
    expect(result.issues.length).toBeGreaterThanOrEqual(3)
    expect(result.issues.every((issue) => issue.reason === 'missing')).toBe(true)
  })

  it('refuses non-absolute paths', () => {
    const result = plan(['uv-cache'], {}, { overrides: { uvCache: 'relative/uv' } })
    expect(result.issues[0]?.reason).toBe('outside-default-bases')
    expect(result.issues[0]?.message).toContain('absolute')
  })

  it('refuses sockets and other non-file non-dir nodes', () => {
    const result = plan(['uv-cache'], { '/home/u/.cache/uv': { uid: 1000, mode: 0o644 } })
    expect(result.issues[0]?.reason).toBe('not-dir-or-file')
  })

  it('an explicit ~/.cache override is honored (operator statement, not a default)', () => {
    // The operator may of course state the broad grant themselves — Pi's
    // allowWrite did exactly this. Defaults can never derive it; only an
    // explicit paths override (or exported anchor) can.
    const result = plan(
      ['uv-cache'],
      { '/home/u/.cache': dir() },
      { overrides: { uvCache: '/home/u/.cache' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual(['/home/u/.cache'])
  })
})

describe('explicit overrides', () => {
  it('an explicit override may sit outside the default base trees', () => {
    const result = plan(
      ['uv-cache'],
      { '/data/uv-cache': dir() },
      { overrides: { uvCache: '/data/uv-cache' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual(['/data/uv-cache'])
  })

  it('cargoHome override anchors all five cargo grants', () => {
    const result = plan(
      ['cargo-cache'],
      {
        '/data/cargo/registry': dir(),
        '/data/cargo/git': dir(),
        '/data/cargo/.package-cache': { file: true, mode: 0o644 },
        '/data/cargo/.package-cache-mutate': { file: true, mode: 0o644 },
        '/data/cargo/.global-cache': { file: true, mode: 0o644 },
      },
      { overrides: { cargoHome: '/data/cargo' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds).toHaveLength(5)
  })
})

describe('dedupe and workspace subtraction', () => {
  it('keeps the outermost path and notes the covered one, regardless of preset order', () => {
    const engineFirst = plan(
      ['pnpm-engine', 'pnpm-store'],
      {
        '/home/u/.local/share/pnpm': dir(),
        '/home/u/.local/share/pnpm/store': dir(),
      },
    )
    const storeFirst = plan(
      ['pnpm-store', 'pnpm-engine'],
      {
        '/home/u/.local/share/pnpm': dir(),
        '/home/u/.local/share/pnpm/store': dir(),
      },
    )
    for (const result of [engineFirst, storeFirst]) {
      expect(result.binds.map((bind) => bind.source)).toEqual(['/home/u/.local/share/pnpm'])
      expect(result.notes).toEqual([
        { preset: 'pnpm-store', path: '/home/u/.local/share/pnpm/store', covered: 'another-grant' },
      ])
    }
  })

  it('drops grants already inside the workspace root', () => {
    const result = plan(
      ['uv-cache'],
      { '/ws/proj/.uv-cache': dir() },
      {
        overrides: { uvCache: '/ws/proj/.uv-cache' },
        workspaceRoots: ['/ws/proj'],
      },
    )
    expect(result.binds).toEqual([])
    expect(result.notes[0]?.covered).toBe('workspace')
  })
})

describe('java toolchain presets', () => {
  const GRADLE_DIRS = [
    '/home/u/.gradle/caches',
    '/home/u/.gradle/wrapper',
    '/home/u/.gradle/daemon',
    '/home/u/.gradle/native',
    '/home/u/.gradle/workers',
    '/home/u/.gradle/notifications',
    '/home/u/.gradle/kotlin-dsl',
    '/home/u/.gradle/.tmp',
  ]
  const gradleTree = (): Record<string, Entry> => ({
    '/home/u/.gradle': dir(),
    ...Object.fromEntries(GRADLE_DIRS.map((path) => [path, dir()])),
  })

  it('gradle-cache grants the cache/lock subdirectories, never the root', () => {
    const entries: Record<string, Entry> = {
      ...gradleTree(),
      '/home/u/.gradle/gradle.properties': { file: true, mode: 0o600 },
    }
    const result = plan(['gradle-cache'], entries)
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual(GRADLE_DIRS)
    // gradle.properties (credential-bearing; here a Nix store symlink) is
    // never in the grant list — the root stays read-only.
    expect(result.binds.some((bind) => bind.source.includes('gradle.properties'))).toBe(false)
  })

  it('gradle-jdks is separate executable-content trust, not part of gradle-cache', () => {
    const withBoth = plan(['gradle-cache', 'gradle-jdks'], { ...gradleTree(), '/home/u/.gradle/jdks': dir() })
    expect(withBoth.issues).toEqual([])
    expect(withBoth.binds.map((bind) => bind.source)).toContain('/home/u/.gradle/jdks')

    const cacheOnly = plan(['gradle-cache'], { ...gradleTree(), '/home/u/.gradle/jdks': dir() })
    expect(cacheOnly.binds.map((bind) => bind.source)).not.toContain('/home/u/.gradle/jdks')
  })

  it('GRADLE_USER_HOME exported counts as explicit: outside HOME ok, never prepared', () => {
    const entries: Record<string, Entry> = {
      '/data/gradle': dir(),
      ...Object.fromEntries(GRADLE_DIRS.map((path) => [path.replace('/home/u/.gradle/', '/data/gradle/'), dir()])),
    }
    const viaEnv = plan(['gradle-cache'], entries, { env: { gradleUserHome: '/data/gradle' } })
    expect(viaEnv.issues).toEqual([])
    expect(viaEnv.binds).toHaveLength(GRADLE_DIRS.length)

    // A missing subdirectory under an explicit anchor fails closed instead
    // of being created (the operator named this tree; defaults only).
    const missingSub = plan(
      ['gradle-cache'],
      { ...entries, '/data/gradle/caches': undefined as unknown as Entry },
      { env: { gradleUserHome: '/data/gradle' }, prepare: true },
    )
    expect(missingSub.binds).toEqual([])
    expect(missingSub.issues[0]?.reason).toBe('missing')
    expect(missingSub.ensured).toEqual([])
  })

  it('maven-cache grants repository/ and wrapper/, never settings.xml at the root', () => {
    const result = plan(['maven-cache'], {
      '/home/u/.m2': dir(),
      '/home/u/.m2/repository': dir(),
      '/home/u/.m2/wrapper': dir(),
      '/home/u/.m2/settings.xml': { file: true, mode: 0o600 },
    })
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual([
      '/home/u/.m2/repository',
      '/home/u/.m2/wrapper',
    ])
    expect(result.binds.some((bind) => bind.source.includes('settings.xml'))).toBe(false)
  })

  it('mavenHome override anchors both maven grants and skips preparation', () => {
    const result = plan(
      ['maven-cache'],
      { '/data/m2/repository': dir(), '/data/m2/wrapper': dir() },
      { overrides: { mavenHome: '/data/m2' }, prepare: true },
    )
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual(['/data/m2/repository', '/data/m2/wrapper'])
    expect(result.ensured).toEqual([])
  })
})

describe('controlled preparation (confine time only)', () => {
  it('creates a missing default lock dir as 0700 (reboot-wiped /run/user)', () => {
    const result = plan(['pnpm-runtime-locks'], { '/run/user/1000': { dir: true, mode: 0o700 } }, { prepare: true })
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual(['/run/user/1000/pnpm-store-operation-locks-1000'])
    expect(result.ensured).toEqual([
      { path: '/run/user/1000/pnpm-store-operation-locks-1000', kind: 'lock-dir' },
    ])
  })

  it('creates missing default cache dirs and the cargo lock files with the right kinds', () => {
    const result = plan(['uv-cache', 'cargo-cache'], {}, { prepare: true })
    expect(result.issues).toEqual([])
    expect(result.ensured).toEqual([
      { path: '/home/u/.cache/uv', kind: 'cache-dir' },
      { path: '/home/u/.cargo/registry', kind: 'cache-dir' },
      { path: '/home/u/.cargo/git', kind: 'cache-dir' },
      { path: '/home/u/.cargo/.package-cache', kind: 'lock-file' },
      { path: '/home/u/.cargo/.package-cache-mutate', kind: 'lock-file' },
      { path: '/home/u/.cargo/.global-cache', kind: 'lock-file' },
    ])
  })

  it('never prepares explicitly configured paths', () => {
    const result = plan(
      ['uv-cache'],
      {},
      { overrides: { uvCache: '/data/uv-cache' }, prepare: true },
    )
    expect(result.binds).toEqual([])
    expect(result.ensured).toEqual([])
    expect(result.issues[0]?.reason).toBe('missing')
  })

  it('never prepares without the prepare flag (plugin load stays side-effect-free)', () => {
    const result = plan(['uv-cache'], {})
    expect(result.ensured).toEqual([])
    expect(result.issues[0]?.reason).toBe('missing')
  })

  it('a concurrent creator racing the ensure still resolves (EEXIST is success)', () => {
    // The lock file appears between our failed realpath and ensure — the
    // ensure then throws EEXIST, which must NOT surface as missing.
    const table: Record<string, Entry> = {
      '/': { dir: true },
      '/home/u/.cargo': { dir: true },
      '/home/u/.cargo/registry': { dir: true },
      '/home/u/.cargo/git': { dir: true },
      // The "other creator" won the race and made all three files:
      '/home/u/.cargo/.package-cache': { file: true, mode: 0o644 },
      '/home/u/.cargo/.package-cache-mutate': { file: true, mode: 0o644 },
      '/home/u/.cargo/.global-cache': { file: true, mode: 0o644 },
    }
    const fs = fakeFs(table)
    fs.ensure = () => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    }
    const result = resolveGrants({
      presets: ['cargo-cache'],
      overrides: {},
      env: ENV,
      workspaceRoots: [],
      fs,
      prepare: true,
    })
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toContain('/home/u/.cargo/.package-cache')
  })

  it('refuses to create a default under a symlinked base pointing at a system tree', () => {
    // ~/.cache -> /var/cache: creating ~/.cache/uv would write into /var
    // BEFORE the floor check could refuse the grant. Pre-flight must reject
    // without any creation.
    const table: Record<string, Entry> = {
      '/': { dir: true },
      '/home/u': { dir: true },
      '/home/u/.cache': { target: '/var/cache' },
      '/var/cache': { dir: true },
    }
    const ensured: string[] = []
    const fs = fakeFs(table)
    fs.ensure = (path) => {
      ensured.push(path)
      table[path] = { dir: true }
    }
    const result = resolveGrants({
      presets: ['uv-cache'],
      overrides: {},
      env: ENV,
      workspaceRoots: [],
      fs,
      prepare: true,
    })
    expect(ensured).toEqual([])
    expect(result.binds).toEqual([])
    expect(result.issues[0]?.reason).toBe('floor-path')
  })
})

describe('helpers', () => {
  it('pathCovers matches exact and descendant only (inputs are canonical by contract)', () => {
    // Non-canonical inputs ('..' segments, unresolved symlinks) are caller
    // error: every grant path is realpath'd before any comparison.
    expect(pathCovers('/a', '/a')).toBe(true)
    expect(pathCovers('/a', '/a/b')).toBe(true)
    expect(pathCovers('/a', '/ab')).toBe(false)
  })

  it('defaultBaseTrees contains the HOME-derived and exported bases', () => {
    expect(defaultBaseTrees(ENV)).toContain('/home/u/.cache')
    expect(defaultBaseTrees(ENV)).toContain('/home/u/.local/share')
    expect(defaultBaseTrees(ENV)).toContain('/run/user/1000')
  })
})
