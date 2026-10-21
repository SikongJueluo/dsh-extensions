/**
 * The pinned bwrap argv contract of `@deepseek-ai/dsh-sandbox-local`
 * 0.2.0-rc.2, and the one edit this package ever makes to it.
 *
 * `LocalSandboxProvider.confine()` returns, for the stock Linux bwrap rung,
 * exactly:
 *
 * ```text
 * bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
 *       [--tmpfs /tmp --bind <canonical workspaceRoot> <same>]   # workspace-write only
 *       -- <caller argv verbatim>
 * ```
 *
 * Grant binds must land AFTER `--ro-bind / /` (later mounts stack on top —
 * verified on-host: an appended `--bind` makes exactly that subtree writable
 * while its parent and siblings stay EROFS) and BEFORE the `--` separator.
 * `insertGrantBinds` verifies the whole expected layout element-by-element
 * and splices the binds in; ANY deviation — a configured `runnerCommand`
 * wrapper, the Landlock/Seatbelt/ACL rungs, a profile change in some future
 * dsh release — fails closed instead of guessing at an unfamiliar layout.
 *
 * The pin is deliberate: this file is the single place to update when a dsh
 * upgrade changes the stock profile, and its tests pin the current shape so
 * the drift surfaces here rather than as a silently weaker sandbox.
 *
 * @module dsh-toolchain-access/bwrap
 */
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** The stock bwrap profile head, identical for both confined modes. */
const STOCK_PROFILE_HEAD: readonly string[] = Object.freeze([
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
])

/**
 * The expected stock profile arguments for one policy (everything between
 * the runner name and the `--` separator), mirroring `bwrapProfileArgs`.
 */
export function expectedStockProfileArgs(policy: SandboxPolicy): string[] {
  const args = [...STOCK_PROFILE_HEAD]
  if (policy.mode === 'workspace-write') {
    const root = canonicalPath(policy.workspaceRoot)
    args.push('--tmpfs', '/tmp', '--bind', root, root)
  }
  return args
}

/** Layout mismatch: the confined argv is not the pinned stock bwrap shape. */
export class GrantArgvError extends Error {
  constructor(detail: string) {
    super(`toolchain-access: refusing to add directory grants — the confined argv is not the pinned stock bwrap layout (${detail}); fail closed instead of editing an unfamiliar sandbox layout`)
    this.name = 'GrantArgvError'
  }
}

/** A grant bind as the splice layer sees it. */
export interface GrantBindSpec {
  readonly source: string
  readonly destination: string
}

function describe(item: string): string {
  return JSON.stringify(item)
}

/**
 * Verify the confined argv against the pinned stock layout and return it
 * with the grant binds spliced in before the `--` separator.
 *
 * The check is structural, not heuristic: argv[0] must be exactly `bwrap`
 * (a configured `runnerCommand` or another rung fails here), every profile
 * element must equal the expected one at its exact index, and everything
 * after `--` must equal the caller's original argv verbatim — so a command
 * argument that happens to contain `--` or bwrap-looking flags cannot move
 * the splice point.
 *
 * @param confined - the argv `super.confine()` produced.
 * @param original - the exact argv that was passed to confine.
 * @param policy - the policy the wrap was built for.
 * @param binds - the validated grant binds (source and destination are the
 *   same spelling, validated by the grants module).
 * @returns the confined argv with `--bind source destination` pairs appended
 *   after the stock profile, before `--`.
 * @throws GrantArgvError on any deviation from the pinned layout.
 */
export function insertGrantBinds(
  confined: readonly string[],
  original: readonly string[],
  policy: SandboxPolicy,
  binds: readonly GrantBindSpec[],
): string[] {
  if (binds.length === 0) return [...confined]
  if (confined[0] !== 'bwrap') {
    throw new GrantArgvError(`runner is ${describe(confined[0] ?? '<empty>')}, not the stock "bwrap" — a configured runnerCommand wrapper or a non-bwrap backend cannot carry directory grants`)
  }
  const expected = expectedStockProfileArgs(policy)
  for (let index = 0; index < expected.length; index += 1) {
    const got = confined[1 + index]
    if (got !== expected[index]) {
      throw new GrantArgvError(`profile argument ${index} is ${describe(got ?? '<missing>')}, expected ${describe(expected[index]!)}`)
    }
  }
  const separator = 1 + expected.length
  if (confined[separator] !== '--') {
    throw new GrantArgvError(`element ${separator} is ${describe(confined[separator] ?? '<missing>')}, expected the "--" separator`)
  }
  const tail = confined.slice(separator + 1)
  if (tail.length !== original.length || tail.some((item, index) => item !== original[index])) {
    throw new GrantArgvError('the argv after "--" is not the caller argv verbatim')
  }
  const grantArgs: string[] = []
  for (const bind of binds) {
    grantArgs.push('--bind', bind.source, bind.destination)
  }
  return [...confined.slice(0, separator), ...grantArgs, ...confined.slice(separator)]
}
