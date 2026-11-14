/**
 * Path rules shared by the persistent store, the policy service, and the
 * browser channel. The enforcing host still validates every grant on every
 * call; these checks are the earlier, clearer refusal at the moment a user
 * adds a directory or a session workspace is first recorded.
 *
 * @module dsh-session-write-access/paths
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** A directory grant that cannot be enforced as a physical absolute directory. */
export class InvalidWriteRootError extends Error {
  constructor(path: string, detail: string) {
    super(`session-write-access: ${JSON.stringify(path)} ${detail}`)
    this.name = 'InvalidWriteRootError'
  }
}

/** A path the standing workspace-write policy must never be able to modify. */
export class ProtectedWriteRootError extends Error {
  constructor(path: string, protectedRoot: string) {
    super(
      `session-write-access: refusing ${JSON.stringify(path)}: it overlaps the protected path `
      + `${JSON.stringify(protectedRoot)} (authorization storage, profile, or plugin code)`,
    )
    this.name = 'ProtectedWriteRootError'
  }
}

/**
 * Expand the two spellings a deployment config can reasonably use without a
 * shell: a leading `~`, `$DSH_HOME`, and `$HOME`. Anything else is kept as-is
 * so an unknown variable fails the absolute-path check instead of silently
 * naming another directory.
 * @param path - configured or submitted path.
 * @param environment - process environment, injectable for tests.
 * @returns the expanded path (still possibly relative).
 */
export function expandPath(path: string, environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME?.trim() || homedir()
  const dshHome = environment.DSH_HOME?.trim() || join(home, '.dsh')
  let expanded = path
  if (expanded === '~') expanded = home
  else if (expanded.startsWith(`~${sep}`)) expanded = join(home, expanded.slice(2))
  expanded = expanded.replaceAll('$DSH_HOME', dshHome).replaceAll('$HOME', home)
  return expanded
}

/**
 * Canonicalize an existing directory without requiring the caller's spelling
 * to be physical. Session workspaces may legitimately be reached through a
 * symlink; the enforcing host canonicalizes them itself, so the recorded root
 * is the real directory.
 * @param path - absolute directory path.
 * @returns the physical directory.
 * @throws {InvalidWriteRootError} when the path is not an existing directory.
 */
export function canonicalDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new InvalidWriteRootError(path, 'must be an absolute directory path without NUL bytes')
  }
  try {
    const physical = realpathSync.native(path)
    if (!statSync(physical).isDirectory()) throw new InvalidWriteRootError(path, 'is not a directory')
    return physical
  } catch (error) {
    if (error instanceof InvalidWriteRootError) throw error
    throw new InvalidWriteRootError(path, `cannot be read: ${String(error)}`)
  }
}

/**
 * Resolve a directory grant the way the enforcing host does: an existing
 * physical directory, spelled as its real path. A symlinked grant is refused
 * rather than canonicalized, matching the stock root validation.
 * @param path - untrusted absolute directory path.
 * @returns the physical absolute directory.
 * @throws {InvalidWriteRootError} when the path is unusable.
 */
export function physicalDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || path.trim() !== path) {
    throw new InvalidWriteRootError(path, 'must be an absolute directory path without NUL bytes or surrounding whitespace')
  }
  let physical: string
  try {
    physical = realpathSync.native(path)
    if (!statSync(physical).isDirectory()) throw new InvalidWriteRootError(path, 'is not a directory')
  } catch (error) {
    if (error instanceof InvalidWriteRootError) throw error
    throw new InvalidWriteRootError(path, `cannot be read: ${String(error)}`)
  }
  if (physical !== resolve(path)) {
    throw new InvalidWriteRootError(path, `must be spelled as its physical path ${JSON.stringify(physical)}; symlinked grants are not supported`)
  }
  return physical
}

/**
 * Whether two physical paths name the same directory or one contains the
 * other. Used to refuse a grant that could rewrite the authorization store
 * and to explain that a revoked child directory is still covered by a parent
 * grant.
 * @param root - a physical absolute directory.
 * @param other - another physical absolute directory.
 * @returns true when either path contains the other.
 */
export function overlaps(root: string, other: string): boolean {
  return root === other || root.startsWith(other + sep) || other.startsWith(root + sep)
}

/**
 * Find the protected path a candidate grant overlaps, if any.
 * @param candidate - physical absolute directory.
 * @param protectedRoots - physical absolute paths that must stay unwritable.
 * @returns the overlapping protected path, or undefined.
 */
export function findProtectedOverlap(
  candidate: string,
  protectedRoots: readonly string[],
): string | undefined {
  return protectedRoots.find(root => overlaps(candidate, root))
}

/**
 * Validate one candidate directory and refuse it when it overlaps protected
 * data.
 * @param path - submitted path.
 * @param protectedRoots - physical absolute protected paths.
 * @returns the physical directory.
 * @throws {InvalidWriteRootError | ProtectedWriteRootError} on refusal.
 */
export function admitWriteRoot(path: string, protectedRoots: readonly string[]): string {
  const physical = physicalDirectory(path)
  const overlap = findProtectedOverlap(physical, protectedRoots)
  if (overlap !== undefined) throw new ProtectedWriteRootError(physical, overlap)
  return physical
}

/**
 * Merge the deployment's extra roots with one group's grants, preserving
 * order and dropping duplicates. The deployment list keeps its own order so
 * stock policy text stays recognizable.
 * @param deploymentRoots - configured `additionalWritableRoots`.
 * @param grantedRoots - the group's currently effective grant paths.
 * @returns a frozen, de-duplicated list, or undefined when empty.
 */
export function mergeWritableRoots(
  deploymentRoots: readonly string[] | undefined,
  grantedRoots: readonly string[],
): readonly string[] | undefined {
  const merged = [...new Set([...(deploymentRoots ?? []), ...grantedRoots])]
  return merged.length === 0 ? undefined : Object.freeze(merged)
}
