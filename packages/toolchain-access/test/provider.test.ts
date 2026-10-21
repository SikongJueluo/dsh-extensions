/**
 * Provider integration tests over the real `ToolchainAccessSandboxProvider`
 * class: the stock bwrap rung forced through `internals`, a fake grant
 * filesystem, and a pinned ambient env — verifying the full confine path:
 * passthrough shapes, splice shape with preserved official metadata,
 * fail-closed on ungrantable presets, fail-closed on non-stock backends,
 * and the workspace subtraction.
 *
 * @module dsh-toolchain-access/provider.test
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
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

/** Deterministic grant filesystem: identity realpath over a stat table. */
function fakeGrantFs(entries: Record<string, { dir?: boolean; file?: boolean; uid?: number; mode?: number }>): GrantFs {
  const table: Record<string, { dir?: boolean; file?: boolean; uid?: number; mode?: number }> = {
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

/** Build a provider with bwrap forced, pinned env, and the fake fs. */
function makeProvider(presets: readonly PresetId[], paths: PathsConfig = {}) {
  const provider = new ToolchainAccessSandboxProvider(fakeCtx(), Config({ presets: [...presets], paths }))
  provider.internals.platform = 'linux'
  provider.internals.probeBwrap = () => true
  provider.grantEnv = grantEnvFrom('/home/u', 1000, { XDG_RUNTIME_DIR: '/run/user/1000' })
  provider.grantFs = fakeGrantFs(ENTRIES)
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

describe('grantEnvFrom', () => {
  it('keeps only absolute exported anchors', () => {
    expect(grantEnvFrom('/home/u', 1000, {
      XDG_RUNTIME_DIR: '/run/user/1000',
      CARGO_HOME: 'relative/path',
      PNPM_HOME: '',
      UV_CACHE_DIR: '/data/uv',
    })).toEqual({
      home: '/home/u',
      uid: 1000,
      xdgRuntimeDir: '/run/user/1000',
      uvCache: '/data/uv',
    })
  })
})
