/**
 * The grant plan: trusted configuration -> validated writable-directory binds, with every refusal carrying its reason.
 * @module dsh-toolchain-access/grants
 */
import { sep } from 'node:path'

export const PRESET_IDS = [
  'uv-cache',
  'typst-cache',
  'cargo-cache',
  'pnpm-store',
  'pnpm-runtime-locks',
  'pnpm-engine',
  'gradle-cache',
  'gradle-jdks',
  'maven-cache',
  'semgrep-state',
] as const

/** One enabled preset. */
export type PresetId = (typeof PRESET_IDS)[number]

/** Ambient host facts the defaults derive from (validated, never trusted blindly). */
export interface GrantEnv {
  home: string
  uid: number
  xdgCacheHome?: string
  xdgDataHome?: string
  xdgRuntimeDir?: string
  xdgConfigHome?: string
  cargoHome?: string
  pnpmHome?: string
  uvCache?: string
  gradleUserHome?: string
  semgrepLogFile?: string
  semgrepVersionCache?: string
}

/** Explicit path overrides from the plugin row's `paths` config. */
export interface GrantOverrides {
  uvCache?: string
  cargoHome?: string
  pnpmHome?: string
  pnpmStore?: string
  pnpmRuntimeLocks?: string
  gradleUserHome?: string
  mavenHome?: string
  semgrepState?: string
  semgrepVersionCache?: string
}

/** The filesystem slice `resolveGrants` needs; sync like the stock provider. */
export interface GrantFs {
  /** Resolve a path to its canonical target; throws when it does not exist. */
  realpath(path: string): string
  /** Stat facts for an existing path. */
  stat(path: string): GrantStat
  ensure?: (path: string, kind: PrepareKind) => void
}

/** How a preset's default path may be prepared when missing. */
export type PrepareKind = 'cache-dir' | 'lock-dir' | 'lock-file' | 'state-file' | 'mount-dir'

/** The stat subset the checks consume. */
export interface GrantStat {
  isDirectory: boolean
  isFile: boolean
  uid: number
  mode: number
}

/** One mount the sandbox adapter adds. For ordinary grants `destination` equals `source`; a private-state shadow (semgrep) mounts a writable host cache directory at a different sandbox path - the destination is only a mount point and is never granted on the host. */
export interface GrantBind {
  readonly source: string
  readonly destination: string
  readonly preset: PresetId
}

/** Why one named grant could not be honored. Every issue fails the confine call. */
export interface GrantIssue {
  readonly preset: PresetId
  readonly path: string
  readonly reason:
    | 'missing'
    | 'not-dir-or-file'
    | 'not-a-directory'
    | 'not-owner'
    | 'not-owner-writable'
    | 'group-or-world-writable'
    | 'floor-path'
    | 'credential-segment'
    | 'outside-default-bases'
    | 'not-strictly-inside-base'
    | 'runtime-dir-unset'
    | 'runtime-dir-unwritable'
    | 'lock-dir-mismatch'
    | 'cache-dir-mismatch'
  readonly message: string
}

/** A grant dropped because it adds nothing (already-covered path); informational. */
export interface GrantNote {
  readonly preset: PresetId
  readonly path: string
  readonly covered: 'workspace' | 'another-grant'
}

/** The resolved plan: the binds to add, plus every refusal and dedup note. */
export interface GrantPlan {
  readonly binds: readonly GrantBind[]
  readonly issues: readonly GrantIssue[]
  readonly notes: readonly GrantNote[]
}

const FLOOR_PREFIXES = Object.freeze([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/media',
  '/nix',
  '/proc',
  '/root',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
])

const CREDENTIAL_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  'gnupg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  '.config',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.npmrc',
  'credentials',
])

function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

function exactFloors(env: GrantEnv, canonicalHome: string): readonly string[] {
  return Object.freeze([
    '/',
    '/home',
    '/mnt',
    '/opt',
    '/run',
    '/run/user',
    joinDir('/run/user', String(env.uid)),
    env.home,
    canonicalHome,
    ...FLOOR_PREFIXES,
  ])
}

/** The verdict for one (canonical) path: which rule refuses it, if any. */
type PathRefusal = 'floor-path' | 'credential-segment'

/** The system-floor half of the refusal rules. Kept separate because a private-state shadow's DESTINATION is a mount point, not a grant: mounting over a credential tree (`$XDG_CONFIG_HOME/.config` included) is exactly what makes semgrep's state private, so only the system floors apply there. */
function pathFloorRefusal(
  path: string,
  env: GrantEnv,
  canonicalHome: string,
): PathRefusal | undefined {
  if (FLOOR_PREFIXES.some((floor) => pathCovers(floor, path))) return 'floor-path'
  if (exactFloors(env, canonicalHome).includes(path)) return 'floor-path'
  return undefined
}

/** The ONE home of the floor/credential judgment, used by both the final grant validation and the controlled-preparation pre-flight - one implementation so the two rule sets can never drift apart. `path` is canonical (post-realpath); `canonicalHome` is the realpath'd HOME. */
function pathRefusal(path: string, env: GrantEnv, canonicalHome: string): PathRefusal | undefined {
  const floor = pathFloorRefusal(path, env, canonicalHome)
  if (floor !== undefined) return floor
  if (path.split(sep).some((segment) => CREDENTIAL_SEGMENTS.has(segment)))
    return 'credential-segment'
  return undefined
}

/** The realpath'd HOME (falls back to the normalized spelling). */
function canonicalHomeOf(env: GrantEnv, fs: GrantFs): string {
  try {
    return fs.realpath(env.home)
  } catch {
    return env.home
  }
}

function preflightRejects(
  path: string,
  env: GrantEnv,
  fs: GrantFs,
  mode: 'grant' | 'mount-point' = 'grant',
): boolean {
  let ancestor = path
  const missing: string[] = []
  let resolved: string | undefined
  while (resolved === undefined) {
    try {
      resolved = fs.realpath(ancestor)
    } catch {
      if (ancestor === '/') return true
      const index = ancestor.lastIndexOf(sep)
      missing.unshift(ancestor.slice(index + 1))
      ancestor = index === 0 ? '/' : ancestor.slice(0, index)
    }
  }
  const effective =
    missing.length === 0
      ? resolved
      : `${resolved === '/' ? '' : resolved}${sep}${missing.join(sep)}`
  const refusal =
    mode === 'mount-point'
      ? pathFloorRefusal(effective, env, canonicalHomeOf(env, fs))
      : pathRefusal(effective, env, canonicalHomeOf(env, fs))
  return refusal !== undefined
}

/** `child === parent` or `child` sits below `parent` (both canonical, absolute). */
export function pathCovers(parent: string, child: string): boolean {
  if (parent === child) return true
  return child.startsWith(parent + sep)
}

function joinDir(base: string, segment: string): string {
  return base.endsWith(sep) ? base + segment : base + sep + segment
}

/** The per-user base trees an implicit-default grant must live inside: HOME (at least two levels down, so `~/.cache` itself is not grantable), the three XDG bases (one level down), and `/run/user/<uid>`. */
export function defaultBaseTrees(env: GrantEnv): readonly string[] {
  const bases = [
    joinDir(env.home, '.cache'),
    joinDir(env.home, `.local${sep}share`),
    env.xdgCacheHome ?? '',
    env.xdgDataHome ?? '',
    env.xdgConfigHome ?? '',
    env.xdgRuntimeDir ?? '',
    env.home,
  ]
  return Object.freeze(bases.filter((base) => isAbsolute(base)))
}

interface NamedPath {
  preset: PresetId
  path: string
  explicit: boolean
  base: string
  prepare: PrepareKind | 'none'
  destination?: string
  prepareDestination?: PrepareKind
}

function semgrepDataDir(env: GrantEnv, fs: GrantFs): string {
  const base =
    env.xdgConfigHome !== undefined && isExistingDirectory(fs, env.xdgConfigHome)
      ? env.xdgConfigHome
      : env.home
  return joinDir(base, '.semgrep')
}

/** The base semgrep writes its version-check file into (its own is_dir() test). */
function semgrepCacheBase(env: GrantEnv, fs: GrantFs): string {
  return env.xdgCacheHome !== undefined && isExistingDirectory(fs, env.xdgCacheHome)
    ? env.xdgCacheHome
    : joinDir(env.home, '.cache')
}

/** True when `path` is an existing directory (semgrep uses `Path.is_dir()`). */
function isExistingDirectory(fs: GrantFs, path: string): boolean {
  try {
    return fs.stat(path).isDirectory
  } catch {
    return false
  }
}

/** First non-empty anchor: the row's paths override wins over the exported env var. */
function pickAnchor(
  override: string | undefined,
  envValue: string | undefined,
): string | undefined {
  if (override !== undefined && override !== '') return override
  if (envValue !== undefined && envValue !== '') return envValue
  return undefined
}

/** Whether an operator statement (override or exported env var) named the anchor. */
function hasAnchor(override: string | undefined, envValue: string | undefined): boolean {
  return pickAnchor(override, envValue) !== undefined
}

/** Derive every named path per preset; unresolved derivations become issues up front. */
function derivePaths(
  presets: readonly PresetId[],
  overrides: Readonly<GrantOverrides>,
  env: GrantEnv,
  fs: GrantFs,
): { named: NamedPath[]; issues: GrantIssue[] } {
  const named: NamedPath[] = []
  const issues: GrantIssue[] = []
  const cacheBase = env.xdgCacheHome ?? joinDir(env.home, '.cache')
  const dataBase = env.xdgDataHome ?? joinDir(env.home, `.local${sep}share`)
  const pnpmHomeBase = env.pnpmHome ?? joinDir(dataBase, 'pnpm')

  const push = (
    preset: PresetId,
    path: string | undefined,
    explicit: boolean,
    base: string,
    prepare: PrepareKind | 'none',
  ): void => {
    if (path === undefined || path === '') return
    named.push({ preset, path, explicit, base, prepare })
  }

  for (const preset of presets) {
    switch (preset) {
      case 'uv-cache': {
        const override = overrides.uvCache
        if (override !== undefined && override !== '') {
          push(preset, override, true, '', 'none')
        } else if (env.uvCache !== undefined && env.uvCache !== '') {
          push(preset, env.uvCache, true, '', 'none')
        } else {
          push(preset, joinDir(cacheBase, 'uv'), false, cacheBase, 'cache-dir')
        }
        break
      }
      case 'typst-cache':
        push(preset, joinDir(cacheBase, 'typst'), false, cacheBase, 'cache-dir')
        break
      case 'cargo-cache': {
        const cargoHome =
          overrides.cargoHome !== undefined && overrides.cargoHome !== ''
            ? overrides.cargoHome
            : env.cargoHome !== undefined && env.cargoHome !== ''
              ? env.cargoHome
              : joinDir(env.home, '.cargo')
        const explicitHome =
          (overrides.cargoHome !== undefined && overrides.cargoHome !== '') ||
          (env.cargoHome !== undefined && env.cargoHome !== '')
        for (const [segment, kind] of [
          ['registry', 'cache-dir'],
          ['git', 'cache-dir'],
          ['.package-cache', 'lock-file'],
          ['.package-cache-mutate', 'lock-file'],
          ['.global-cache', 'lock-file'],
        ] as const) {
          push(
            preset,
            joinDir(cargoHome, segment),
            explicitHome,
            cargoHome,
            explicitHome ? 'none' : kind,
          )
        }
        break
      }
      case 'pnpm-store': {
        const override = overrides.pnpmStore
        if (override !== undefined && override !== '') push(preset, override, true, '', 'none')
        else {
          const envPnpmHome = env.pnpmHome !== undefined && env.pnpmHome !== ''
          push(
            preset,
            joinDir(pnpmHomeBase, 'store'),
            envPnpmHome,
            pnpmHomeBase,
            envPnpmHome ? 'none' : 'cache-dir',
          )
        }
        break
      }
      case 'pnpm-runtime-locks': {
        const override = overrides.pnpmRuntimeLocks
        if (override !== undefined && override !== '') {
          push(preset, override, true, '', 'none')
        } else if (env.xdgRuntimeDir !== undefined && env.xdgRuntimeDir !== '') {
          push(
            preset,
            joinDir(env.xdgRuntimeDir, `pnpm-store-operation-locks-${env.uid}`),
            false,
            env.xdgRuntimeDir,
            'lock-dir',
          )
        }
        break
      }
      case 'pnpm-engine': {
        const override = overrides.pnpmHome
        if (override !== undefined && override !== '') push(preset, override, true, '', 'none')
        else {
          const envPnpmHome = env.pnpmHome !== undefined && env.pnpmHome !== ''
          push(preset, pnpmHomeBase, envPnpmHome, dataBase, envPnpmHome ? 'none' : 'cache-dir')
        }
        break
      }
      case 'gradle-cache': {
        const gradleHome =
          pickAnchor(overrides.gradleUserHome, env.gradleUserHome) ?? joinDir(env.home, '.gradle')
        const explicitHome = hasAnchor(overrides.gradleUserHome, env.gradleUserHome)
        for (const segment of [
          'caches',
          'wrapper',
          'daemon',
          'native',
          'workers',
          'notifications',
          'kotlin-dsl',
          '.tmp',
        ]) {
          push(
            preset,
            joinDir(gradleHome, segment),
            explicitHome,
            gradleHome,
            explicitHome ? 'none' : 'cache-dir',
          )
        }
        break
      }
      case 'gradle-jdks': {
        const gradleHome =
          pickAnchor(overrides.gradleUserHome, env.gradleUserHome) ?? joinDir(env.home, '.gradle')
        const explicitHome = hasAnchor(overrides.gradleUserHome, env.gradleUserHome)
        push(
          preset,
          joinDir(gradleHome, 'jdks'),
          explicitHome,
          gradleHome,
          explicitHome ? 'none' : 'cache-dir',
        )
        break
      }
      case 'maven-cache': {
        const mavenHome =
          overrides.mavenHome !== undefined && overrides.mavenHome !== ''
            ? overrides.mavenHome
            : joinDir(env.home, '.m2')
        const explicitHome = overrides.mavenHome !== undefined && overrides.mavenHome !== ''
        for (const segment of ['repository', 'wrapper']) {
          push(
            preset,
            joinDir(mavenHome, segment),
            explicitHome,
            mavenHome,
            explicitHome ? 'none' : 'cache-dir',
          )
        }
        break
      }
      case 'semgrep-state': {
        const stateCacheBase = semgrepCacheBase(env, fs)
        const stateOverride = overrides.semgrepState
        const stateExplicit = stateOverride !== undefined && stateOverride !== ''
        const state = stateExplicit ? stateOverride : joinDir(stateCacheBase, 'semgrep-state')
        const dataDir = semgrepDataDir(env, fs)
        named.push({
          preset,
          path: state,
          explicit: stateExplicit,
          base: stateCacheBase,
          prepare: stateExplicit ? 'none' : 'cache-dir',
          destination: dataDir,
          prepareDestination: 'mount-dir',
        })
        if (
          env.semgrepLogFile !== undefined &&
          env.semgrepLogFile !== '' &&
          !pathCovers(dataDir, env.semgrepLogFile)
        ) {
          push(preset, env.semgrepLogFile, true, '', 'none')
        }
        const version = pickAnchor(overrides.semgrepVersionCache, env.semgrepVersionCache)
        if (version !== undefined) {
          if (!pathCovers(dataDir, version)) push(preset, version, true, '', 'none')
        } else {
          push(preset, joinDir(cacheBase, 'semgrep_version'), false, cacheBase, 'state-file')
        }
        break
      }
    }
  }
  return { named, issues }
}

/** Stable errno code for a failed controlled preparation, when the failure carries one. */
function prepareErrorDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(code) ? ` (${code})` : ''
}

function resolveShadowDestination(input: {
  preset: PresetId
  destination: string
  prepareDestination: PrepareKind | undefined
  env: GrantEnv
  fs: GrantFs
  prepare: boolean | undefined
  canonicalHome: string
}): { destination: string } | { issue: GrantIssue } {
  const { preset, destination, prepareDestination, env, fs, prepare, canonicalHome } = input
  const issue = (reason: GrantIssue['reason'], message: string): { issue: GrantIssue } => ({
    issue: { preset, path: destination, reason, message },
  })

  if (!isAbsolute(destination)) {
    return issue(
      'outside-default-bases',
      `${preset}: private-state mount point must be absolute: ${destination}`,
    )
  }
  let canonical: string
  let prepareFailure: unknown
  try {
    canonical = fs.realpath(destination)
  } catch {
    const rejected = preflightRejects(destination, env, fs, 'mount-point')
    const kind = prepareDestination
    const guarded = prepare === true && kind !== undefined && fs.ensure !== undefined && !rejected
    if (!guarded || kind === undefined) {
      return issue(
        rejected ? 'floor-path' : 'missing',
        rejected
          ? `${preset}: private-state mount point ${destination} resolves into a system tree — refusing to create or mount it`
          : `${preset}: private-state mount point ${destination} does not exist on the host — bwrap cannot create it under its read-only root, so the private state directory has nowhere to mount; prepare it (see the package README) or disable the preset`,
      )
    }
    try {
      fs.ensure?.(destination, kind)
    } catch (error) {
      prepareFailure = error
    }
    try {
      canonical = fs.realpath(destination)
    } catch {
      return issue(
        'missing',
        `${preset}: private-state mount point ${destination} still missing after controlled preparation${prepareErrorDetail(prepareFailure)}`,
      )
    }
  }
  let stat: GrantStat
  try {
    stat = fs.stat(canonical)
  } catch {
    return issue(
      'missing',
      `${preset}: private-state mount point ${destination} disappeared between resolution and stat`,
    )
  }
  if (!stat.isDirectory) {
    return issue(
      'not-a-directory',
      `${preset}: private-state mount point ${destination} is not a directory — refusals keep bwrap from mounting a directory source over a file`,
    )
  }
  if (pathFloorRefusal(canonical, env, canonicalHome) !== undefined) {
    return issue(
      'floor-path',
      `${preset}: private-state mount point ${destination} resolves to ${canonical}, a system or session root — refusing to mount there`,
    )
  }
  return { destination: canonical }
}

/** Drop trailing slashes; a root-only path stays `/`. */
function stripSlashes(path: string): string {
  const stripped = path.replace(/\/+$/u, '')
  return stripped === '' ? '/' : stripped
}

export function resolveGrants(input: {
  presets: readonly PresetId[]
  overrides: Readonly<GrantOverrides>
  env: GrantEnv
  workspaceRoots: readonly string[]
  fs: GrantFs
  prepare?: boolean
}): GrantPlan {
  const { presets, overrides, workspaceRoots, fs, prepare } = input
  const env: GrantEnv = {
    ...input.env,
    home: stripSlashes(input.env.home),
    ...(input.env.xdgCacheHome === undefined
      ? {}
      : { xdgCacheHome: stripSlashes(input.env.xdgCacheHome) }),
    ...(input.env.xdgDataHome === undefined
      ? {}
      : { xdgDataHome: stripSlashes(input.env.xdgDataHome) }),
    ...(input.env.xdgRuntimeDir === undefined
      ? {}
      : { xdgRuntimeDir: stripSlashes(input.env.xdgRuntimeDir) }),
    ...(input.env.xdgConfigHome === undefined
      ? {}
      : { xdgConfigHome: stripSlashes(input.env.xdgConfigHome) }),
    ...(input.env.cargoHome === undefined ? {} : { cargoHome: stripSlashes(input.env.cargoHome) }),
    ...(input.env.pnpmHome === undefined ? {} : { pnpmHome: stripSlashes(input.env.pnpmHome) }),
    ...(input.env.uvCache === undefined ? {} : { uvCache: stripSlashes(input.env.uvCache) }),
    ...(input.env.gradleUserHome === undefined
      ? {}
      : { gradleUserHome: stripSlashes(input.env.gradleUserHome) }),
    ...(input.env.semgrepLogFile === undefined
      ? {}
      : { semgrepLogFile: stripSlashes(input.env.semgrepLogFile) }),
    ...(input.env.semgrepVersionCache === undefined
      ? {}
      : { semgrepVersionCache: stripSlashes(input.env.semgrepVersionCache) }),
  }
  const { named, issues } = derivePaths(presets, overrides, env, fs)
  const notes: GrantNote[] = []
  const canonicalHome = canonicalHomeOf(env, fs)

  let runtimeDirBroken = false
  let pnpmLockCanonical: string | undefined
  const runtimePresetEnabled = presets.includes('pnpm-runtime-locks')
  if (runtimePresetEnabled) {
    if (env.xdgRuntimeDir === undefined) {
      runtimeDirBroken = true
      issues.push({
        preset: 'pnpm-runtime-locks',
        path: '<unset>',
        reason: 'runtime-dir-unset',
        message:
          'pnpm-runtime-locks needs a valid XDG_RUNTIME_DIR on the host: pnpm otherwise locks /tmp, which inside the sandbox is a private per-call tmpfs (split lock domain). Setting paths.pnpmRuntimeLocks cannot redirect pnpm — fix the runtime dir instead.',
      })
    } else {
      try {
        const runtimeStat = fs.stat(env.xdgRuntimeDir)
        const pnpmUsable =
          runtimeStat.isDirectory &&
          runtimeStat.uid === env.uid &&
          (runtimeStat.mode & 0o300) === 0o300 &&
          (runtimeStat.mode & 0o022) === 0
        if (!pnpmUsable) {
          runtimeDirBroken = true
          issues.push({
            preset: 'pnpm-runtime-locks',
            path: env.xdgRuntimeDir,
            reason: 'runtime-dir-unwritable',
            message: `pnpm-runtime-locks: ${env.xdgRuntimeDir} fails pnpm's runtime-root conditions (directory, uid ${env.uid}, owner write+search, group/other not writable); pnpm would fall back to a private /tmp lock dir inside the sandbox (split lock domain) — fix the runtime dir itself, an explicit paths.pnpmRuntimeLocks cannot redirect pnpm`,
          })
        } else {
          const lockName = `pnpm-store-operation-locks-${env.uid}`
          const derived = joinDir(env.xdgRuntimeDir, lockName)
          try {
            pnpmLockCanonical = fs.realpath(derived)
          } catch {
            try {
              pnpmLockCanonical = joinDir(fs.realpath(env.xdgRuntimeDir), lockName)
            } catch {
              pnpmLockCanonical = derived
            }
          }
        }
      } catch {
        runtimeDirBroken = true
        issues.push({
          preset: 'pnpm-runtime-locks',
          path: env.xdgRuntimeDir,
          reason: 'runtime-dir-unwritable',
          message: `pnpm-runtime-locks: ${env.xdgRuntimeDir} does not exist — pnpm would fall back to a private /tmp lock dir inside the sandbox (split lock domain); an explicit paths.pnpmRuntimeLocks cannot redirect pnpm`,
        })
      }
    }
  }

  interface Resolved extends NamedPath {
    canonical: string
  }
  interface ShadowResolved extends Resolved {
    destination: string
    destinationCanonical: string
  }
  const resolved: Resolved[] = []
  const shadows: ShadowResolved[] = []

  for (const entry of named) {
    if (runtimeDirBroken && entry.preset === 'pnpm-runtime-locks') {
      continue
    }
    if (!isAbsolute(entry.path)) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'outside-default-bases',
        message: `grant path must be absolute: ${entry.path}`,
      })
      continue
    }
    let canonical: string
    try {
      canonical = fs.realpath(entry.path)
    } catch {
      const preflight = preflightRejects(entry.path, env, fs)
      const kind = entry.prepare === 'none' ? undefined : entry.prepare
      const guarded =
        prepare === true &&
        !entry.explicit &&
        kind !== undefined &&
        fs.ensure !== undefined &&
        !preflight
      if (!guarded || kind === undefined) {
        issues.push(
          preflight
            ? {
                preset: entry.preset,
                path: entry.path,
                reason: 'floor-path',
                message: `${entry.preset}: ${entry.path} resolves into a system or credential tree — refusing to create or grant it`,
              }
            : {
                preset: entry.preset,
                path: entry.path,
                reason: 'missing',
                message: `${entry.preset}: ${entry.path} does not exist on the host — prepare it (see the package README's host-prep section) or disable the preset; the sandbox will not run with a configured grant it cannot honor`,
              },
        )
        continue
      }
      let prepareFailure: unknown
      try {
        fs.ensure?.(entry.path, kind)
      } catch (error) {
        prepareFailure = error
      }
      try {
        canonical = fs.realpath(entry.path)
      } catch {
        issues.push({
          preset: entry.preset,
          path: entry.path,
          reason: 'missing',
          message: `${entry.preset}: ${entry.path} still missing after controlled preparation${prepareErrorDetail(prepareFailure)}`,
        })
        continue
      }
    }
    const refusal = pathRefusal(canonical, env, canonicalHome)
    if (refusal === 'floor-path') {
      const isHome = canonical === env.home || canonical === canonicalHome
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'floor-path',
        message: isHome
          ? `${entry.preset}: ${entry.path} resolves to the home directory itself — grant the specific cache directories instead`
          : `${entry.preset}: ${entry.path} resolves to ${canonical}, a shared or session root — grant the specific directory inside it instead`,
      })
      continue
    }
    if (refusal === 'credential-segment') {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'credential-segment',
        message: `${entry.preset}: ${entry.path} crosses a credential/configuration tree (${canonical}) — cache grants must not make secrets or tool config writable`,
      })
      continue
    }
    if (
      entry.preset === 'pnpm-runtime-locks' &&
      pnpmLockCanonical !== undefined &&
      canonical !== pnpmLockCanonical
    ) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'lock-dir-mismatch',
        message: `${entry.preset}: ${entry.path} resolves to ${canonical}, but pnpm will lock ${pnpmLockCanonical} (derived from $XDG_RUNTIME_DIR, which pnpm cannot be redirected from) — grant that directory or fix the runtime dir`,
      })
      continue
    }
    let stat: GrantStat
    try {
      stat = fs.stat(canonical)
    } catch {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'missing',
        message: `${entry.preset}: ${entry.path} disappeared between resolution and stat`,
      })
      continue
    }
    if (!stat.isDirectory && !stat.isFile) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'not-dir-or-file',
        message: `${entry.preset}: ${entry.path} is neither a regular file nor a directory`,
      })
      continue
    }
    if (entry.preset === 'typst-cache' && !stat.isDirectory) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'not-a-directory',
        message: `${entry.preset}: ${entry.path} is not a directory`,
      })
      continue
    }
    if (entry.destination !== undefined && !stat.isDirectory) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'not-a-directory',
        message: `${entry.preset}: private-state source ${entry.path} is not a directory — it is mounted over ${entry.destination}, and bwrap cannot mount a file onto a directory`,
      })
      continue
    }
    if (stat.uid !== env.uid) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'not-owner',
        message: `${entry.preset}: ${entry.path} is owned by uid ${stat.uid}, not the harness user ${env.uid} — refusing a grant over foreign-owned state`,
      })
      continue
    }
    if ((stat.mode & 0o022) !== 0) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'group-or-world-writable',
        message: `${entry.preset}: ${entry.path} is group- or world-writable — tighten its permissions before granting it`,
      })
      continue
    }
    if ((stat.mode & 0o200) === 0) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'not-owner-writable',
        message: `${entry.preset}: ${entry.path} is not owner-writable — a grant over it would still fail the tool's writes`,
      })
      continue
    }
    if (!entry.explicit) {
      const canonicalOf = (candidate: string): string => {
        try {
          return fs.realpath(candidate)
        } catch {
          return candidate
        }
      }
      if (entry.preset === 'typst-cache') {
        const cacheDir = joinDir(canonicalOf(entry.base), 'typst')
        if (canonical !== cacheDir) {
          issues.push({
            preset: entry.preset,
            path: entry.path,
            reason: 'cache-dir-mismatch',
            message: `${entry.preset}: ${entry.path} resolves to ${canonical}, outside its exact cache location ${cacheDir}`,
          })
          continue
        }
      }
      const spelled = defaultBaseTrees(env)
      const canonicalBases = spelled.map((candidate) => canonicalOf(candidate))
      const homeBase = canonicalOf(env.home)
      const base =
        canonicalBases.find((candidate) => pathCovers(candidate, canonical)) ??
        spelled.find((candidate) => pathCovers(candidate, canonical))
      if (base === undefined) {
        issues.push({
          preset: entry.preset,
          path: entry.path,
          reason: 'outside-default-bases',
          message: `${entry.preset}: default-derived ${canonical} sits outside the per-user base trees — configure paths explicitly if this is intended`,
        })
        continue
      }
      const depth = canonical
        .slice(base.length + 1)
        .split(sep)
        .filter((part) => part !== '').length
      const isHomeBase = base === homeBase || base === env.home
      if (isHomeBase ? depth < 2 : depth < 1) {
        issues.push({
          preset: entry.preset,
          path: entry.path,
          reason: 'not-strictly-inside-base',
          message: `${entry.preset}: ${canonical} is a base tree itself (${base}) — grant the specific cache directories inside it`,
        })
        continue
      }
    }
    if (entry.destination !== undefined) {
      const destination = resolveShadowDestination({
        preset: entry.preset,
        destination: entry.destination,
        prepareDestination: entry.prepareDestination,
        env,
        fs,
        prepare,
        canonicalHome,
      })
      if ('issue' in destination) {
        issues.push(destination.issue)
        continue
      }
      shadows.push({
        ...entry,
        canonical,
        destination: entry.destination,
        destinationCanonical: destination.destination,
      })
      continue
    }
    resolved.push({ ...entry, canonical })
  }

  const workspace = workspaceRoots.filter((root) => isAbsolute(root))
  const kept: Resolved[] = resolved.filter((entry) => {
    if (workspace.some((root) => pathCovers(root, entry.canonical))) {
      notes.push({ preset: entry.preset, path: entry.path, covered: 'workspace' })
      return false
    }
    return true
  })

  const ordered = [...kept].toSorted((a, b) => a.canonical.length - b.canonical.length)
  const keptCanonical = new Set<string>()
  for (const entry of ordered) {
    const covered = [...keptCanonical].some((parent) => pathCovers(parent, entry.canonical))
    if (covered) {
      notes.push({ preset: entry.preset, path: entry.path, covered: 'another-grant' })
      continue
    }
    keptCanonical.add(entry.canonical)
  }
  const binds: GrantBind[] = kept
    .filter((entry) => keptCanonical.has(entry.canonical))
    .map((entry) => ({
      source: entry.canonical,
      destination: entry.canonical,
      preset: entry.preset,
    }))

  const shadowBinds: GrantBind[] = []
  const shadowDestinations = new Set<string>()
  for (const entry of shadows) {
    if (workspace.some((root) => pathCovers(root, entry.destinationCanonical))) {
      notes.push({ preset: entry.preset, path: entry.path, covered: 'workspace' })
      continue
    }
    if (
      shadowDestinations.has(entry.destinationCanonical) ||
      binds.some((bind) => pathCovers(bind.destination, entry.destinationCanonical))
    ) {
      notes.push({ preset: entry.preset, path: entry.path, covered: 'another-grant' })
      continue
    }
    shadowDestinations.add(entry.destinationCanonical)
    shadowBinds.push({
      source: entry.canonical,
      destination: entry.destinationCanonical,
      preset: entry.preset,
    })
  }
  const allBinds = [...binds, ...shadowBinds]

  if (issues.length > 0) return { binds: [], issues, notes }
  return { binds: allBinds, issues, notes }
}
