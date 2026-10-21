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

/** Deterministic in-memory fs: table-driven realpath + stat. */
function fakeFs(entries: Record<string, Entry>): GrantFs {
  const stat = (path: string) => {
    const entry = entries[path]
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
        const entry = entries[current]
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
  const ensured: Array<{ path: string; kind: string }> = []
  const fs: GrantFs = fakeFs(entries)
  fs.ensure = (path, kind) => {
    ensured.push({ path, kind })
    entries[path] = kind === 'lock-file' ? { file: true, mode: 0o644 } : { dir: true, mode: kind === 'lock-dir' ? 0o700 : 0o755 }
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
        '/home/u/.local/share/pnpm/store': dir(),
        '/home/u/.local/share/pnpm': dir(),
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
        '/data/pnpm/store': dir(),
      },
      { env: { cargoHome: '/data/cargo', pnpmHome: '/data/pnpm' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual([
      '/data/cargo/registry',
      '/data/cargo/git',
      '/data/cargo/.package-cache',
      '/data/pnpm/store',
    ])
  })

  it('refuses pnpm-runtime-locks without XDG_RUNTIME_DIR (shared lock domain would split)', () => {
    const result = plan(['pnpm-runtime-locks'], {}, { env: { xdgRuntimeDir: undefined } })
    expect(result.binds).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe('runtime-dir-unset')
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

  it('refuses credential and tool-config trees', () => {
    const result = plan(
      ['uv-cache'],
      { '/home/u/.ssh/uv': dir() },
      { overrides: { uvCache: '/home/u/.ssh/uv' } },
    )
    expect(result.issues[0]?.reason).toBe('credential-segment')
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

  it('cargoHome override anchors all three cargo grants', () => {
    const result = plan(
      ['cargo-cache'],
      {
        '/data/cargo/registry': dir(),
        '/data/cargo/git': dir(),
        '/data/cargo/.package-cache': { file: true, mode: 0o644 },
      },
      { overrides: { cargoHome: '/data/cargo' } },
    )
    expect(result.issues).toEqual([])
    expect(result.binds).toHaveLength(3)
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

describe('controlled preparation (confine time only)', () => {
  it('creates a missing default lock dir as 0700 (reboot-wiped /run/user)', () => {
    const result = plan(['pnpm-runtime-locks'], {}, { prepare: true })
    expect(result.issues).toEqual([])
    expect(result.binds.map((bind) => bind.source)).toEqual(['/run/user/1000/pnpm-store-operation-locks-1000'])
    expect(result.ensured).toEqual([
      { path: '/run/user/1000/pnpm-store-operation-locks-1000', kind: 'lock-dir' },
    ])
  })

  it('creates missing default cache dirs and the cargo lock file with the right kinds', () => {
    const result = plan(['uv-cache', 'cargo-cache'], {}, { prepare: true })
    expect(result.issues).toEqual([])
    expect(result.ensured).toEqual([
      { path: '/home/u/.cache/uv', kind: 'cache-dir' },
      { path: '/home/u/.cargo/registry', kind: 'cache-dir' },
      { path: '/home/u/.cargo/git', kind: 'cache-dir' },
      { path: '/home/u/.cargo/.package-cache', kind: 'lock-file' },
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
