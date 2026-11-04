/**
 * Provider integration tests with stock bwrap, pinned host env and a fake filesystem.
 * Cover schema-default grants, explicit overrides, passthrough and fail-closed behavior.
 * @module dsh-toolchain-access/provider.test
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_PRESETS,
  ToolchainAccessSandboxProvider,
  ToolchainGrantError,
  grantEnvFrom,
  type GrantFs,
  type PathsConfig,
  type PresetId,
} from '../src/index.js'

/** Minimal cordis context: Service registration, dispose effect, logger. */
function fakeCtx() {
  return {
    reflect: { provide: () => () => Promise.resolve() },
    effect: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  } as never
}

interface FakeEntry {
  dir?: boolean
  file?: boolean
  uid?: number
  mode?: number
}

/** Deterministic grant filesystem: identity realpath over a stat table. */
function fakeGrantFs(entries: Record<string, FakeEntry>): GrantFs {
  const table: Record<string, FakeEntry> = {
    '/': { dir: true },
    ...entries,
  }
  return {
    realpath: (path) => {
      if (!(path in table)) throw new Error(`ENOENT: ${path}`)
      return path
    },
    stat: (path) => {
      const entry = table[path]
      if (entry === undefined) throw new Error(`ENOENT: ${path}`)
      return {
        isDirectory: entry.dir ?? false,
        isFile: entry.file ?? false,
        uid: entry.uid ?? 1000,
        mode: entry.mode ?? 0o755,
      }
    },
  }
}

const ENTRIES = {
  '/home/u/.cache/uv': { dir: true },
  '/home/u/.cargo/registry': { dir: true },
  '/home/u/.cargo/git': { dir: true },
  '/home/u/.cargo/.package-cache': { file: true, mode: 0o644 },
  '/run/user/1000/pnpm-store-operation-locks-1000': { dir: true, mode: 0o700 },
} as const

/** Every path the seven default presets derive (HOME/XDG defaults, no overrides). */
const DEFAULT_ENTRIES: Record<string, FakeEntry> = {
  ...ENTRIES,
  '/home/u/.cargo/.package-cache-mutate': { file: true, mode: 0o644 },
  '/home/u/.cargo/.global-cache': { file: true, mode: 0o644 },
  '/home/u/.local/share/pnpm/store': { dir: true },
  '/run/user/1000': { dir: true, mode: 0o700 },
  ...Object.fromEntries(
    ['caches', 'wrapper', 'daemon', 'native', 'workers', 'notifications', 'kotlin-dsl', '.tmp'].map(
      (sub) => [`/home/u/.gradle/${sub}`, { dir: true }],
    ),
  ),
  '/home/u/.m2/repository': { dir: true },
  '/home/u/.m2/wrapper': { dir: true },
  // semgrep-state: the writable private state dir, the version-check cache
  // file, and the sandbox mount point that shadows the host's ~/.semgrep.
  '/home/u/.cache/semgrep-state': { dir: true },
  '/home/u/.cache/semgrep_version': { file: true, mode: 0o644 },
  '/home/u/.semgrep': { dir: true },
}

/** The binds the seven defaults produce, in derivation (preset) order. */
const DEFAULT_BINDS: Array<[source: string, destination: string]> = [
  ['/home/u/.cache/uv', '/home/u/.cache/uv'],
  ['/home/u/.cargo/registry', '/home/u/.cargo/registry'],
  ['/home/u/.cargo/git', '/home/u/.cargo/git'],
  ['/home/u/.cargo/.package-cache', '/home/u/.cargo/.package-cache'],
  ['/home/u/.cargo/.package-cache-mutate', '/home/u/.cargo/.package-cache-mutate'],
  ['/home/u/.cargo/.global-cache', '/home/u/.cargo/.global-cache'],
  ['/home/u/.local/share/pnpm/store', '/home/u/.local/share/pnpm/store'],
  ['/run/user/1000/pnpm-store-operation-locks-1000', '/run/user/1000/pnpm-store-operation-locks-1000'],
  ['/home/u/.gradle/caches', '/home/u/.gradle/caches'],
  ['/home/u/.gradle/wrapper', '/home/u/.gradle/wrapper'],
  ['/home/u/.gradle/daemon', '/home/u/.gradle/daemon'],
  ['/home/u/.gradle/native', '/home/u/.gradle/native'],
  ['/home/u/.gradle/workers', '/home/u/.gradle/workers'],
  ['/home/u/.gradle/notifications', '/home/u/.gradle/notifications'],
  ['/home/u/.gradle/kotlin-dsl', '/home/u/.gradle/kotlin-dsl'],
  ['/home/u/.gradle/.tmp', '/home/u/.gradle/.tmp'],
  ['/home/u/.m2/repository', '/home/u/.m2/repository'],
  ['/home/u/.m2/wrapper', '/home/u/.m2/wrapper'],
  ['/home/u/.cache/semgrep_version', '/home/u/.cache/semgrep_version'],
  // The shadow mount: the host's ~/.semgrep is never writable; the private
  // state directory is what semgrep sees there.
  ['/home/u/.cache/semgrep-state', '/home/u/.semgrep'],
]

/** Build a provider with bwrap forced, pinned env, and the fake fs. */
function makeProvider(presets: readonly PresetId[], paths: PathsConfig = {}) {
  return mountedProvider(Config({ presets: [...presets], paths }))
}

/** The same mounts for an already-resolved row config (e.g. the schema default). */
function mountedProvider(config: Config, entries: Record<string, FakeEntry> = ENTRIES) {
  const provider = new ToolchainAccessSandboxProvider(fakeCtx(), config)
  provider.internals.platform = 'linux'
  provider.internals.probeBwrap = () => true
  provider.grantEnv = grantEnvFrom('/home/u', 1000, { XDG_RUNTIME_DIR: '/run/user/1000' })
  provider.grantFs = fakeGrantFs(entries)
  return provider
}

const COMMAND = ['cargo', 'build']
const WS_POLICY = { mode: 'workspace-write' as const, workspaceRoot: '/ws/proj' }
const RO_POLICY = { mode: 'read-only' as const, workspaceRoot: '/ws/proj' }

describe('ToolchainAccessSandboxProvider.confine', () => {
  it('appends grant binds to the stock workspace-write wrap and preserves official metadata', async () => {
    const provider = makeProvider(['uv-cache'])
    const result = await provider.confine(COMMAND, WS_POLICY)
    expect(result.enforcement).toBe('full')
    expect(result.denialSignatures).toEqual(['read-only file system'])
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--tmpfs', '/tmp',
      '--bind', '/ws/proj', '/ws/proj',
      '--bind', '/home/u/.cache/uv', '/home/u/.cache/uv',
      '--', 'cargo', 'build',
    ])
  })

  it('returns read-only wraps untouched even with presets enabled', async () => {
    const provider = makeProvider(['uv-cache', 'cargo-cache'])
    const result = await provider.confine(COMMAND, RO_POLICY)
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--', 'cargo', 'build',
    ])
  })

  it('returns the stock wrap verbatim when no presets are enabled', async () => {
    const provider = makeProvider([])
    const result = await provider.confine(COMMAND, WS_POLICY)
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--tmpfs', '/tmp',
      '--bind', '/ws/proj', '/ws/proj',
      '--', 'cargo', 'build',
    ])
  })

  it('drops grants already covered by the workspace bind', async () => {
    const provider = makeProvider([], { uvCache: '/ws/proj/.uv-cache' })
    provider.grantPresets = ['uv-cache']
    // The fake fs lacks the workspace path; point the override at a path
    // inside the workspace that exists in the table via uv-cache default.
    provider.grantPaths = {}
    provider.grantFs = fakeGrantFs({ '/home/u/.cache/uv': { dir: true } })
    const result = await provider.confine(COMMAND, { mode: 'workspace-write', workspaceRoot: '/home/u' })
    // HOME is the workspace root here: the uv grant is inside it, so the
    // wrap must stay exactly stock.
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--tmpfs', '/tmp',
      '--bind', '/home/u', '/home/u',
      '--', 'cargo', 'build',
    ])
  })

  it('fails closed with TOOLCHAIN_GRANT_UNAVAILABLE when a preset cannot be honored', async () => {
    const provider = makeProvider(['uv-cache'])
    provider.grantFs = fakeGrantFs({})
    const attempt = provider.confine(COMMAND, WS_POLICY)
    await expect(attempt).rejects.toBeInstanceOf(ToolchainGrantError)
    await expect(attempt).rejects.toMatchObject({
      code: 'TOOLCHAIN_GRANT_UNAVAILABLE',
      issues: [{ preset: 'uv-cache', reason: 'missing' }],
    })
  })

  it('fails closed when a configured runnerCommand wrapper carries the wrap', async () => {
    const provider = new ToolchainAccessSandboxProvider(fakeCtx(), Config({
      presets: ['uv-cache'],
      runnerCommand: ['/opt/bwrap-shim'],
      runnerFailureSignatures: ['bwrap: '],
    }))
    provider.grantEnv = grantEnvFrom('/home/u', 1000, {})
    provider.grantFs = fakeGrantFs(ENTRIES)
    await expect(provider.confine(COMMAND, WS_POLICY)).rejects.toThrow(/not the pinned stock bwrap layout/)
  })

  it('fails closed when the Linux chain selects the Landlock rung', async () => {
    const provider = new ToolchainAccessSandboxProvider(fakeCtx(), Config({ presets: ['uv-cache'] }))
    provider.internals.platform = 'linux'
    provider.internals.probeBwrap = () => false
    provider.internals.probeLandlock = () => 'full'
    provider.internals.landlockLauncher = '/fake/landlock-run'
    provider.grantEnv = grantEnvFrom('/home/u', 1000, {})
    provider.grantFs = fakeGrantFs(ENTRIES)
    await expect(provider.confine(COMMAND, WS_POLICY)).rejects.toThrow(/not the pinned stock bwrap layout/)
  })

  it('rejects unknown preset ids at config time', () => {
    expect(() => Config({ presets: ['not-a-preset'] } as never)).toThrow()
  })
})

describe('config default presets', () => {
  it('omitting presets enables the seven ordinary cache/state presets, never the whole-toolchain presets', () => {
    expect(DEFAULT_PRESETS).toEqual([
      'uv-cache',
      'cargo-cache',
      'pnpm-store',
      'pnpm-runtime-locks',
      'gradle-cache',
      'maven-cache',
      'semgrep-state',
    ])
    expect(Config({}).presets).toEqual(DEFAULT_PRESETS)
    expect(Config().presets).toEqual(DEFAULT_PRESETS)
    expect(Config({}).presets).not.toContain('pnpm-engine')
    expect(Config({}).presets).not.toContain('gradle-jdks')
  })

  it('an explicit list replaces the default exactly: [] stays off, subsets stay subsets', () => {
    expect(Config({ presets: [] }).presets).toEqual([])
    expect(Config({ presets: ['uv-cache'] }).presets).toEqual(['uv-cache'])
    expect(Config({ presets: ['pnpm-engine', 'gradle-jdks'] }).presets).toEqual(['pnpm-engine', 'gradle-jdks'])
  })

  it('the schema default reaches confine: binds for exactly the seven presets', async () => {
    const provider = mountedProvider(Config({}), DEFAULT_ENTRIES)
    const result = await provider.confine(COMMAND, WS_POLICY)
    expect(result.enforcement).toBe('full')
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--tmpfs', '/tmp',
      '--bind', '/ws/proj', '/ws/proj',
      ...DEFAULT_BINDS.flatMap(([source, destination]) => ['--bind', source, destination]),
      '--', 'cargo', 'build',
    ])
  })

  it('read-only wraps stay untouched under the schema default', async () => {
    const provider = mountedProvider(Config({}), DEFAULT_ENTRIES)
    const result = await provider.confine(COMMAND, RO_POLICY)
    expect(result.argv).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--', 'cargo', 'build',
    ])
  })

  it('an unhonorable default fails closed instead of being silently skipped', async () => {
    const provider = mountedProvider(Config({}), DEFAULT_ENTRIES)
    provider.grantEnv = grantEnvFrom('/home/u', 1000, {})
    await expect(provider.confine(COMMAND, WS_POLICY)).rejects.toMatchObject({
      code: 'TOOLCHAIN_GRANT_UNAVAILABLE',
      issues: [{ preset: 'pnpm-runtime-locks', reason: 'runtime-dir-unset' }],
    })
  })
})

describe('grantEnvFrom', () => {
  it('keeps only absolute exported anchors', () => {
    expect(grantEnvFrom('/home/u', 1000, {
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CONFIG_HOME: '/home/u/.config',
      CARGO_HOME: 'relative/path',
      PNPM_HOME: '',
      UV_CACHE_DIR: '/data/uv',
      SEMGREP_LOG_FILE: '/data/logs/semgrep.log',
      SEMGREP_VERSION_CACHE_PATH: 'relative/cache',
    })).toEqual({
      home: '/home/u',
      uid: 1000,
      xdgRuntimeDir: '/run/user/1000',
      xdgConfigHome: '/home/u/.config',
      uvCache: '/data/uv',
      semgrepLogFile: '/data/logs/semgrep.log',
    })
  })
})
