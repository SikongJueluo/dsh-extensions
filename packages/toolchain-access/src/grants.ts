/**
 * The grant plan: trusted configuration → validated writable-directory
 * binds, with every refusal carrying its reason.
 *
 * This module is the one home for what a "toolchain cache preset" means:
 * which paths each preset names, how defaults derive from the ambient host
 * environment, and which safety floors no grant may cross. It is pure —
 * every filesystem or environment fact arrives as an argument, so the whole
 * policy is testable without a host.
 *
 * Trust model, in one paragraph: the plugin row's `paths` config and the
 * ambient host environment (HOME, XDG dirs, CARGO_HOME/PNPM_HOME/
 * UV_CACHE_DIR as exported by the operator's session) are *statements* the
 * operator made — grants derived from them only need the hard floors. Paths
 * that come from implicit defaults (nothing configured, nothing exported)
 * must additionally stay inside the well-known per-user base trees. The
 * agent's own claims (command text, justifications, repo files, session env
 * overlays) are never a source here: `auto-env` may point a command's
 * `UV_CACHE_DIR` anywhere — that changes where uv *writes*, not what this
 * layer *grants*; the mismatch then surfaces as an ordinary sandbox denial
 * for the operator to resolve explicitly.
 *
 * What validation can and cannot promise: `realpath`+`stat` here runs at
 * confine time in the host process, and bwrap re-resolves the same spelling
 * moments later — a symlink swap in between is a residual race the same
 * argv-level seam always had (the stock workspace bind shares it). The
 * checks below make stale, foreign-owned, group-writable, credential-tree
 * and floor paths ungrantable; they do not make the window zero.
 *
 * @module dsh-toolchain-access/grants
 */
import { sep } from 'node:path'

/** Built-in preset ids (the registry's complete vocabulary). */
export const PRESET_IDS = [
  'uv-cache',
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
  /** Absolute home directory of the host user (`os.homedir()`). */
  home: string
  /** Host user id (`process.getuid()`); grants must be owned by this uid. */
  uid: number
  /** `$XDG_CACHE_HOME` when the operator exported one (absolute). */
  xdgCacheHome?: string
  /** `$XDG_DATA_HOME` when the operator exported one (absolute). */
  xdgDataHome?: string
  /** `$XDG_RUNTIME_DIR` when the operator exported one (absolute). */
  xdgRuntimeDir?: string
  /** `$XDG_CONFIG_HOME` when the operator exported one (absolute). */
  xdgConfigHome?: string
  /** `$CARGO_HOME` when the operator exported one (absolute). */
  cargoHome?: string
  /** `$PNPM_HOME` when the operator exported one (absolute). */
  pnpmHome?: string
  /** `$UV_CACHE_DIR` when the operator exported one (absolute). */
  uvCache?: string
  /** `$GRADLE_USER_HOME` when the operator exported one (absolute). */
  gradleUserHome?: string
  /** `$SEMGREP_LOG_FILE` when the operator exported one (absolute). */
  semgrepLogFile?: string
  /** `$SEMGREP_VERSION_CACHE_PATH` when the operator exported one (absolute). */
  semgrepVersionCache?: string
}

/** Explicit path overrides from the plugin row's `paths` config. */
export interface GrantOverrides {
  /** The uv cache directory itself (default `$XDG_CACHE_HOME/uv`). */
  uvCache?: string
  /** CARGO_HOME anchor (default `$CARGO_HOME` or `~/.cargo`). */
  cargoHome?: string
  /** pnpm home anchor — store + engine + global root (default `$PNPM_HOME` or `~/.local/share/pnpm`). */
  pnpmHome?: string
  /** The package store directory (default `<pnpm home>/store`). */
  pnpmStore?: string
  /** The shared operation-lock directory (default `$XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>`). */
  pnpmRuntimeLocks?: string
  /** GRADLE_USER_HOME anchor for gradle-cache/gradle-jdks (default `$GRADLE_USER_HOME` or `~/.gradle`). */
  gradleUserHome?: string
  /** Maven user home anchor for maven-cache (default `~/.m2`; Maven has no standard env var for it). */
  mavenHome?: string
  /** Host directory mounted over semgrep's data dir in the sandbox (default `<cache base>/semgrep-state`). */
  semgrepState?: string
  /** The semgrep version-check cache file (default `<cache base>/semgrep_version`). */
  semgrepVersionCache?: string
}

/** The filesystem slice `resolveGrants` needs; sync like the stock provider. */
export interface GrantFs {
  /** Resolve a path to its canonical target; throws when it does not exist. */
  realpath(path: string): string
  /** Stat facts for an existing path. */
  stat(path: string): GrantStat
  /**
   * Controlled preparation of a missing default-derived path (never called
   * for explicitly configured ones): create the cache directory, the 0700
   * shared-lock directory, or the empty lock file exactly as the owning
   * tool itself would. Optional so pure tests can omit it.
   */
  ensure?: (path: string, kind: PrepareKind) => void
}

/** How a preset's default path may be prepared when missing. */
export type PrepareKind = 'cache-dir' | 'lock-dir' | 'lock-file' | 'state-file' | 'mount-dir'

/** The stat subset the checks consume. */
export interface GrantStat {
  isDirectory: boolean
  isFile: boolean
  /** Owning uid. */
  uid: number
  /** Permission bits. */
  mode: number
}

/**
 * One mount the sandbox adapter adds. For ordinary grants `destination`
 * equals `source`; a private-state shadow (semgrep) mounts a writable host
 * cache directory at a different sandbox path — the destination is only a
 * mount point and is never granted on the host.
 */
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

/**
 * Absolute filesystem roots INSIDE which no grant may ever sit — system
 * trees where a writable bind would subordinate unrelated state. `/tmp` is
 * here on purpose: the sandbox's `/tmp` is a private tmpfs, so nothing
 * under host `/tmp` is a meaningful grant target. User-owned subtrees
 * (`/home/<user>/…`, `/run/user/<uid>/…`) are NOT here — they are the
 * normal grant locations, guarded by the exact floors and base checks.
 */
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

/**
 * Path segments that mark credential or token trees. A grant whose path
 * crosses one is refused: cache presets must never make secrets, tokens or
 * tool config writable (reads stay confined-but-allowed, exactly as
 * before — this layer adds write grants only).
 */
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

/**
 * Paths a grant may never BE, even though paths below them may be fine:
 * `/home` itself (all users' homes) versus `/home/<user>/…`; `/run` and
 * `/run/user` versus a lock directory inside them; mount roots whose
 * children an operator may still name explicitly. Plus this user's home —
 * both its CURRENT spelling and its canonical (realpath) form, so a
 * symlinked HOME cannot smuggle a whole-home grant past the exact check —
 * and their `/run/user/<uid>` (the runtime dir holds session sockets such
 * as the agent and wayland; making it wholesale writable is never a cache
 * grant).
 */
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

/**
 * The system-floor half of the refusal rules. Kept separate because a
 * private-state shadow's DESTINATION is a mount point, not a grant: mounting
 * over a credential tree (`$XDG_CONFIG_HOME/.config` included) is exactly
 * what makes semgrep's state private, so only the system floors apply there.
 */
function pathFloorRefusal(
  path: string,
  env: GrantEnv,
  canonicalHome: string,
): PathRefusal | undefined {
  if (FLOOR_PREFIXES.some((floor) => pathCovers(floor, path))) return 'floor-path'
  if (exactFloors(env, canonicalHome).includes(path)) return 'floor-path'
  return undefined
}

/**
 * The ONE home of the floor/credential judgment, used by both the final
 * grant validation and the controlled-preparation pre-flight — one
 * implementation so the two rule sets can never drift apart. `path` is
 * canonical (post-realpath); `canonicalHome` is the realpath'd HOME.
 */
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

/**
 * Pre-flight for controlled preparation: would creating `path` land inside a
 * system floor (or, for grant sources, a credential tree)? Resolves the
 * nearest EXISTING ancestor (the base being a symlink then points at the real
 * target) and applies the SAME refusal rules as the final validation to the
 * resolved ancestor plus the still-missing segments. Returns true when
 * creation must NOT happen.
 */
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

/**
 * The per-user base trees an implicit-default grant must live inside:
 * HOME (at least two levels down, so `~/.cache` itself is not grantable),
 * the three XDG bases (one level down), and `/run/user/<uid>`.
 */
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
  /** The spelling the tool and bwrap will both use. */
  path: string
  /** True when an operator statement (config override or exported env var) named this path. */
  explicit: boolean
  /** The anchor tree an implicit default must sit inside (empty for explicit paths). */
  base: string
  /** Controlled preparation allowed for a missing implicit default (never for explicit paths). */
  prepare: PrepareKind | 'none'
  /**
   * Set only for a private-state shadow: the sandbox path the writable
   * `path` is mounted over. The destination is a mount point, not a grant —
   * it is never made writable on the host.
   */
  destination?: string
  /** Controlled preparation for a missing shadow destination (empty mount directory). */
  prepareDestination?: PrepareKind
}

/**
 * Semgrep's own storage layout, mirrored from pysemgrep (`env.py`) and
 * osemgrep (`Semgrep_envvars.ml`):
 * - data folder: `$XDG_CONFIG_HOME/.semgrep` when `XDG_CONFIG_HOME` is an
 *   EXISTING directory, else `~/.semgrep` (note: semgrep joins `.semgrep`
 *   directly under XDG_CONFIG_HOME, unlike the usual XDG layout);
 * - cache base for the version-check file: `$XDG_CACHE_HOME` when it is an
 *   existing directory, else `~/.cache`.
 */
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
          // Cargo 1.74+ carries TWO global cache locks — the shared
          // download lock and the mutate lock guarding MutateExclusive
          // operations (auto-gc). Binding only the first makes cargo's
          // mutate-lock open fail EROFS and SILENTLY degrade to running
          // unlocked, which quietly dissolves mutual exclusion with
          // concurrent host-side cargo. .global-cache is the use-tracking
          // sqlite (degrades with a warning when read-only); granting it
          // keeps auto-gc accounting working.
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
        // pnpm derives its lock dir from $XDG_RUNTIME_DIR alone (plus its
        // own validity conditions) — no pnpm setting and nothing in this
        // plugin can redirect it. The runtime-root validation therefore
        // lives in resolveGrants and runs for EXPLICIT overrides too; here
        // we only name the candidate path (the override spelling, or
        // pnpm's derived one).
        const override = overrides.pnpmRuntimeLocks
        if (override !== undefined && override !== '') {
          push(preset, override, true, '', 'none')
        } else if (env.xdgRuntimeDir !== undefined && env.xdgRuntimeDir !== '') {
          // pnpm's secure_user_lock_dir(): $XDG_RUNTIME_DIR + name + "-<uid>".
          push(
            preset,
            joinDir(env.xdgRuntimeDir, `pnpm-store-operation-locks-${env.uid}`),
            false,
            env.xdgRuntimeDir,
            'lock-dir',
          )
        }
        // XDG unset: resolveGrants rejects the preset below (an explicit
        // override cannot help — pnpm would still lock /tmp).
        break
      }
      case 'pnpm-engine': {
        // The whole pnpm home: package-manager-store, global env lockfile and
        // the _tmp staging pnpm creates there. This includes executable
        // engine copies — enabling this preset is a separate, deliberate
        // trust decision, which is why it is not part of any other preset.
        const override = overrides.pnpmHome
        if (override !== undefined && override !== '') push(preset, override, true, '', 'none')
        else {
          const envPnpmHome = env.pnpmHome !== undefined && env.pnpmHome !== ''
          push(preset, pnpmHomeBase, envPnpmHome, dataBase, envPnpmHome ? 'none' : 'cache-dir')
        }
        break
      }
      case 'gradle-cache': {
        // Subdirectories of GRADLE_USER_HOME only: caches/ (dependencies,
        // transforms, ALL file locks — verified on-host), wrapper/ (the
        // wrapper's downloaded distributions), daemon/ (registry + logs),
        // native/ (file-watching state), workers/, notifications/,
        // kotlin-dsl/ (script compilation cache + repo mirror) and .tmp/
        // (Gradle's staging area directly under the user home — verified:
        // a build fails creating it when the root is read-only). The ROOT
        // itself stays read-only on purpose: gradle.properties there is
        // often credential-bearing (signing passwords, repo tokens) and on
        // this host is a home-manager/Nix store symlink.
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
        // Gradle's auto-provisioned toolchain JDKs (<gradle home>/jdks):
        // EXECUTABLE content, so it is its own preset — the same separate
        // trust decision as pnpm-engine — and never part of gradle-cache.
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
        // ~/.m2/repository (local repo = dependency cache; resolver writes
        // .lastUpdated/_remote.repositories inside it) and ~/.m2/wrapper
        // (mvnw distributions). settings.xml at the ~/.m2 root stays
        // read-only: it carries server credentials. Maven has no standard
        // env var for the user home, so only the paths override can move it
        // (settings.xml <localRepository> relocations must be configured
        // here explicitly).
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
        // Semgrep's data folder must be writable as a DIRECTORY, not just
        // file-by-file: pysemgrep's Settings.save() runs on every invocation
        // and rewrites settings.yml atomically (mkstemp INSIDE the folder,
        // then rename). A read-only folder dies with EROFS before the scan
        // starts — the Python catch covers PermissionError only, and EROFS is
        // a plain OSError (verified on-host with 1.182.1). The folder also
        // holds settings.yml, which may carry the Semgrep API token, so it is
        // never granted: a private state directory is bind-mounted OVER it in
        // the sandbox. The sandbox writes only that copy; the host folder
        // (and any login stored there) stays invisible and untouched.
        //
        // The version-check cache is a separate ordinary file outside the
        // data folder (~/.cache/semgrep_version), written by the CLI after
        // the version fetch; its absence likewise fails the run.
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
        // SEMGREP_LOG_FILE moves the log out of the shadowed folder: honor
        // the operator's exact file as a plain grant (logs carry no
        // credentials). A log inside the data folder is covered by the
        // shadow and needs no separate bind.
        if (
          env.semgrepLogFile !== undefined &&
          env.semgrepLogFile !== '' &&
          !pathCovers(dataDir, env.semgrepLogFile)
        ) {
          push(preset, env.semgrepLogFile, true, '', 'none')
        }
        // Version cache: row override > $SEMGREP_VERSION_CACHE_PATH > default.
        // A path inside the shadowed folder is covered by the shadow mount.
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

/**
 * Resolve (and, at confine time, create) a private-state shadow's mount
 * point. The destination is never granted: only its counterpart source is
 * writable on the host. The checks are therefore the FLOOR half only —
 * mounting over a credential tree is the very thing that keeps the host's
 * credential-bearing `settings.yml` out of the sandbox — plus a directory
 * type check, because bwrap mounts a directory source onto a directory
 * destination and cannot create a missing destination under its read-only
 * root.
 */
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
    } catch {
      // A concurrent confine may have created it first (EEXIST is success).
    }
    try {
      canonical = fs.realpath(destination)
    } catch {
      return issue(
        'missing',
        `${preset}: private-state mount point ${destination} still missing after controlled preparation`,
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

/**
 * Resolve the enabled presets into a validated, deduplicated bind plan.
 *
 * Order of checks per named path: floors and credential segments (on the
 * canonical target), existence and type, ownership, write-mode bits, then —
 * for implicit defaults only — containment in the derived base tree.
 * Everything refused becomes an issue; the caller fails closed on any.
 *
 * @param input - presets, overrides, ambient env, workspace roots to
 *   subtract (paths the sandbox already writes), the fs slice, and whether
 *   missing implicit defaults may be prepared (confine time only).
 * @returns the plan (binds may be empty; issues mean "cannot honor").
 */
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
  // Normalize the ambient anchors first: a trailing-slash HOME (real on
  // some hosts — os.homedir() returns it verbatim) would otherwise make
  // every path-cover comparison miss and refuse all defaults fail-closed.
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
  // The realpath'd HOME: every whole-home floor comparison happens in this
  // canonical space so `HOME=/link -> /real` cannot grant `/real` wholesale.
  const canonicalHome = canonicalHomeOf(env, fs)

  // pnpm 12.8.2+ chooses its lock dir from $XDG_RUNTIME_DIR alone, and
  // only when the runtime dir passes pnpm's own conditions; otherwise it
  // silently falls back to /tmp — inside the sandbox a private per-call
  // tmpfs. Nothing in this plugin (and nothing in pnpm's own settings)
  // can redirect that choice, so EVERY pnpm-runtime-locks grant — explicit
  // override included — must satisfy: (a) the runtime root exists and
  // passes pnpm's conditions, and (b) the granted path IS the lock dir
  // pnpm will actually use. An override may only re-spell that path (a
  // symlink), never relocate it; a broken runtime root cannot be "fixed"
  // by configuring a path.
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
        // Replicate pnpm's OWN runtime-root conditions exactly
        // (secure_temp_lock.rs): a directory owned by this uid that the
        // owner can write AND search, with group/other write bits clear.
        // Anything less and pnpm falls back to /tmp — a grant would cover
        // a lock domain pnpm never uses (verified: a 0775 runtime dir is
        // refused by pnpm even when the lock directory inside it exists).
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
          // pnpm's actual lock dir, canonicalized with the same fallback
          // the grant paths get, so the comparison below is like-for-like.
          // When the dir does not exist yet (fresh boot), its FUTURE
          // canonical form is the canonical RUNTIME ROOT plus the lock dir
          // name: falling back to the raw spelling here would misreport
          // lock-dir-mismatch on the first confine after controlled
          // creation under a symlinked runtime root (safe-direction false
          // refusal, fixed here).
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
      // The runtime-root issue above already fails the plan; skip the
      // entries pnpm would not actually use (explicit overrides included).
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
      // Controlled preparation, only for implicit defaults of a preset (the
      // operator enabled the preset, which names exactly these paths), never
      // for explicit overrides or full-path env anchors, and only when the
      // caller asked to act (confine time — plugin load stays
      // side-effect-free). `/run/user/<uid>` is tmpfs: pnpm's lock dir
      // vanishes every reboot, so without this the preset would fail closed
      // until someone ran pnpm outside the sandbox once.
      //
      // Pre-flight BEFORE creating anything: resolve the nearest EXISTING
      // ancestor and run the floor/credential checks against it plus the
      // remaining segments, so a symlinked base (say ~/.cache -> /var/x)
      // is rejected without ever writing into the never-grantable target.
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
      try {
        fs.ensure?.(entry.path, kind)
      } catch {
        // A concurrent creator (another confine, or the tool itself) may
        // have made the path first — EEXIST is success for our purpose.
      }
      try {
        canonical = fs.realpath(entry.path)
      } catch {
        issues.push({
          preset: entry.preset,
          path: entry.path,
          reason: 'missing',
          message: `${entry.preset}: ${entry.path} still missing after controlled preparation`,
        })
        continue
      }
    }
    // Floors and credential trees are judged on the canonical target via
    // the shared refusal rules (also used by the preparation pre-flight),
    // with the realpath'd HOME in scope so a symlinked HOME cannot bypass
    // the whole-home floor.
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
    // The pnpm lock-dir grant must be the dir pnpm will ACTUALLY use:
    // pnpm derives it from $XDG_RUNTIME_DIR alone, so an explicit override
    // may re-spell that path but never relocate it — a grant over any other
    // directory would cover a lock domain pnpm ignores while the real locks
    // land in a private sandbox /tmp.
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
    // A shadow source is mounted OVER its destination, so bwrap requires a
    // directory here even though plain grants may also be single files.
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
    // Owner-write is part of the promise: a 0555 cache directory would
    // pass the checks above and then EROFS/EACCES at first use, failing
    // the tool in exactly the way this plugin exists to prevent.
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
      // Match bases in canonical space too: on a host whose HOME is itself a
      // symlink (e.g. /home/user -> /data/user), the canonical grant path
      // sits under the REAL base while the derived spelling does not — an
      // un-canonicalized comparison would refuse every default there. A
      // base that cannot be resolved falls back to its spelling (a missing
      // base simply matches nothing, the conservative outcome).
      const canonicalOf = (candidate: string): string => {
        try {
          return fs.realpath(candidate)
        } catch {
          return candidate
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
      // Segments below the matched base: an XDG base needs one (the base
      // itself is not grantable); HOME needs two (so `~/.cache` or `~/.cargo`
      // as a whole stay out, `~/.cache/uv` and `~/.cargo/registry` pass).
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
    // Private-state shadows: the validated source is mounted at a DIFFERENT
    // sandbox path. The destination is a mount point, so only the system
    // floors apply to it (a credential tree such as
    // `$XDG_CONFIG_HOME/.semgrep` is exactly what a private state directory
    // has to be mounted over) and a missing one may be created empty.
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

  // Subtract what the sandbox already writes: a grant inside the workspace
  // root adds no capability, so it becomes a note instead of a bind.
  const workspace = workspaceRoots.filter((root) => isAbsolute(root))
  const kept: Resolved[] = resolved.filter((entry) => {
    if (workspace.some((root) => pathCovers(root, entry.canonical))) {
      notes.push({ preset: entry.preset, path: entry.path, covered: 'workspace' })
      return false
    }
    return true
  })

  // Dedupe overlaps keeping the outermost path (it covers the inner ones).
  // Walk a length-sorted copy so the kept SET is independent of preset
  // order (pnpm-engine + pnpm-store keep the pnpm home either way), then
  // emit in the original derivation order for stable, readable argvs.
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

  // Private-state shadows are about the sandbox VIEW, not new host write
  // capability: the same host directory may already be writable through
  // another grant, yet the mount is still required to make the destination
  // writable (and to keep the host's own folder — and any credentials in it
  // — out of view). They are therefore never deduped against normal binds
  // nor subtracted by source. They ARE dropped when the sandbox already
  // writes the destination itself: a workspace root covering the mount
  // point, or a plain grant that made the destination writable.
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

  // All-or-nothing: with any issue the caller fails the confined command,
  // so a plan carrying binds alongside issues would only invite partial
  // consumption. An honest plan is either fully grantable or empty.
  if (issues.length > 0) return { binds: [], issues, notes }
  return { binds: allBinds, issues, notes }
}
