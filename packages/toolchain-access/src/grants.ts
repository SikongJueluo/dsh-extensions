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
  /** `$CARGO_HOME` when the operator exported one (absolute). */
  cargoHome?: string
  /** `$PNPM_HOME` when the operator exported one (absolute). */
  pnpmHome?: string
  /** `$UV_CACHE_DIR` when the operator exported one (absolute). */
  uvCache?: string
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
export type PrepareKind = 'cache-dir' | 'lock-dir' | 'lock-file'

/** The stat subset the checks consume. */
export interface GrantStat {
  isDirectory: boolean
  isFile: boolean
  /** Owning uid. */
  uid: number
  /** Permission bits. */
  mode: number
}

/** One writable bind the sandbox adapter adds (source and destination are the same spelling). */
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
    | 'not-owner'
    | 'group-or-world-writable'
    | 'floor-path'
    | 'credential-segment'
    | 'outside-default-bases'
    | 'not-strictly-inside-base'
    | 'runtime-dir-unset'
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
 * Paths a grant may never BE, even though paths below them may be fine:
 * `/home` itself (all users' homes) versus `/home/<user>/…`; `/run` and
 * `/run/user` versus a lock directory inside them; mount roots whose
 * children an operator may still name explicitly. Plus this user's
 * `/run/user/<uid>` — the runtime dir holds session sockets (agent,
 * wayland), and making it wholesale writable is never a cache grant.
 */
function exactFloors(env: GrantEnv): readonly string[] {
  return Object.freeze([
    '/',
    '/home',
    '/mnt',
    '/opt',
    '/run',
    '/run/user',
    joinDir('/run/user', String(env.uid)),
    ...FLOOR_PREFIXES,
  ])
}

/**
 * Path segments that mark credential or tool-configuration trees. A grant
 * whose path crosses one is refused: cache presets must never make secrets
 * or tool config writable (reads stay confined-but-allowed, exactly as
 * before — this layer adds write grants only).
 */
const CREDENTIAL_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.config',
  'credentials',
])

function isAbsolute(path: string): boolean {
  return path.startsWith('/')
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
    joinDir(env.home, '.local' + sep + 'share'),
    env.xdgCacheHome ?? '',
    env.xdgDataHome ?? '',
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
}

/** Derive every named path per preset; unresolved derivations become issues up front. */
function derivePaths(
  presets: readonly PresetId[],
  overrides: Readonly<GrantOverrides>,
  env: GrantEnv,
): { named: NamedPath[]; issues: GrantIssue[] } {
  const named: NamedPath[] = []
  const issues: GrantIssue[] = []
  const cacheBase = env.xdgCacheHome ?? joinDir(env.home, '.cache')
  const dataBase = env.xdgDataHome ?? joinDir(env.home, '.local' + sep + 'share')
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
        const cargoHome = overrides.cargoHome !== undefined && overrides.cargoHome !== ''
          ? overrides.cargoHome
          : env.cargoHome !== undefined && env.cargoHome !== ''
            ? env.cargoHome
            : joinDir(env.home, '.cargo')
        const explicitHome = overrides.cargoHome !== undefined && overrides.cargoHome !== ''
          || env.cargoHome !== undefined && env.cargoHome !== ''
        for (const [segment, kind] of [
          ['registry', 'cache-dir'],
          ['git', 'cache-dir'],
          ['.package-cache', 'lock-file'],
        ] as const) {
          push(preset, joinDir(cargoHome, segment), explicitHome, cargoHome, explicitHome ? 'none' : kind)
        }
        break
      }
      case 'pnpm-store': {
        const override = overrides.pnpmStore
        if (override !== undefined && override !== '') push(preset, override, true, '', 'none')
        else {
          const envPnpmHome = env.pnpmHome !== undefined && env.pnpmHome !== ''
          push(preset, joinDir(pnpmHomeBase, 'store'), envPnpmHome, pnpmHomeBase, envPnpmHome ? 'none' : 'cache-dir')
        }
        break
      }
      case 'pnpm-runtime-locks': {
        const override = overrides.pnpmRuntimeLocks
        if (override !== undefined && override !== '') {
          push(preset, override, true, '', 'none')
        } else if (env.xdgRuntimeDir !== undefined && env.xdgRuntimeDir !== '') {
          // pnpm's secure_user_lock_dir(): $XDG_RUNTIME_DIR + name + "-<uid>".
          // Without XDG_RUNTIME_DIR pnpm falls back to /tmp — inside the
          // sandbox that is a private per-call tmpfs, which would split the
          // shared lock domain this preset exists to preserve. Refuse.
          push(preset, joinDir(env.xdgRuntimeDir, `pnpm-store-operation-locks-${env.uid}`), false, env.xdgRuntimeDir, 'lock-dir')
        } else {
          issues.push({
            preset,
            path: '<unset>',
            reason: 'runtime-dir-unset',
            message: 'pnpm-runtime-locks needs XDG_RUNTIME_DIR on the host (pnpm otherwise locks a private sandbox /tmp, splitting the shared lock domain); set it or configure paths.pnpmRuntimeLocks explicitly',
          })
        }
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
    }
  }
  return { named, issues }
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
export function resolveGrants(input: {
  presets: readonly PresetId[]
  overrides: Readonly<GrantOverrides>
  env: GrantEnv
  workspaceRoots: readonly string[]
  fs: GrantFs
  prepare?: boolean
}): GrantPlan {
  const { presets, overrides, env, workspaceRoots, fs } = input
  const { named, issues } = derivePaths(presets, overrides, env)
  const notes: GrantNote[] = []

  interface Resolved extends NamedPath {
    canonical: string
  }
  const resolved: Resolved[] = []

  for (const entry of named) {
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
      // for explicit overrides or exported anchors, and only when the caller
      // asked to act (confine time — plugin load stays side-effect-free).
      // `/run/user/<uid>` is tmpfs: pnpm's lock dir vanishes every reboot,
      // so without this the preset would fail closed until someone ran pnpm
      // outside the sandbox once.
      let prepared = false
      if (input.prepare === true && !entry.explicit && entry.prepare !== 'none' && fs.ensure !== undefined) {
        try {
          fs.ensure(entry.path, entry.prepare)
          prepared = true
        } catch {
          prepared = false
        }
      }
      if (!prepared) {
        issues.push({
          preset: entry.preset,
          path: entry.path,
          reason: 'missing',
          message: `${entry.preset}: ${entry.path} does not exist on the host — prepare it (see the package README's host-prep section) or disable the preset; the sandbox will not run with a configured grant it cannot honor`,
        })
        continue
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
    // Floors are judged on the canonical target: a symlink must not smuggle
    // a grant into a system tree. Prefix floors exclude the whole subtree;
    // exact floors exclude only the named root (children may be grantable).
    if (FLOOR_PREFIXES.some((floor) => pathCovers(floor, canonical))) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'floor-path',
        message: `${entry.preset}: ${entry.path} resolves to ${canonical}, inside a shared system root — never grantable`,
      })
      continue
    }
    if (exactFloors(env).includes(canonical)) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'floor-path',
        message: `${entry.preset}: ${entry.path} resolves to ${canonical}, a shared or session root — grant the specific directory inside it instead`,
      })
      continue
    }
    if (canonical.split(sep).some((segment) => CREDENTIAL_SEGMENTS.has(segment))) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'credential-segment',
        message: `${entry.preset}: ${entry.path} crosses a credential/configuration tree (${canonical}) — cache grants must not make secrets or tool config writable`,
      })
      continue
    }
    if (canonical === env.home) {
      issues.push({
        preset: entry.preset,
        path: entry.path,
        reason: 'floor-path',
        message: `${entry.preset}: ${entry.path} resolves to the home directory itself — grant the specific cache directories instead`,
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
    if (!entry.explicit) {
      const bases = defaultBaseTrees(env)
      const base = bases.find((candidate) => pathCovers(candidate, canonical))
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
      const depth = canonical.slice(base.length + 1).split(sep).filter((part) => part !== '').length
      if (base === env.home ? depth < 2 : depth < 1) {
        issues.push({
          preset: entry.preset,
          path: entry.path,
          reason: 'not-strictly-inside-base',
          message: `${entry.preset}: ${canonical} is a base tree itself (${base}) — grant the specific cache directories inside it`,
        })
        continue
      }
    }
    resolved.push({ ...entry, canonical })
  }

  // Subtract what the sandbox already writes: a grant inside the workspace
  // root adds no capability, so it becomes a note instead of a bind.
  const workspace = workspaceRoots.filter(isAbsolute)
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
  const ordered = [...kept].sort((a, b) => a.canonical.length - b.canonical.length)
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
    .map((entry) => ({ source: entry.canonical, destination: entry.canonical, preset: entry.preset }))

  return { binds, issues, notes }
}
