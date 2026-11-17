/**
 * The pinned bwrap argv contract of `@deepseek-ai/dsh-sandbox-local` 0.2.2-rc.1, and the one edit this package ever makes to it.
 * @module dsh-toolchain-access/bwrap
 */
import { workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const STOCK_PROFILE_HEAD: readonly string[] = Object.freeze([
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--unshare-pid',
  '--proc',
  '/proc',
  '--die-with-parent',
])

/** The expected stock profile arguments for one policy (everything between the runner name and the `--` separator), mirroring `bwrapProfileArgs`. */
export function expectedStockProfileArgs(policy: SandboxPolicy): string[] {
  const args = [...STOCK_PROFILE_HEAD]
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    for (const root of workspaceWritableRoots(policy)) args.push('--bind', root, root)
  }
  return args
}

/** Layout mismatch: the confined argv is not the pinned stock bwrap shape. */
export class GrantArgvError extends Error {
  constructor(detail: string) {
    super(
      `toolchain-access: refusing to add directory grants — the confined argv is not the pinned stock bwrap layout (${detail}); fail closed instead of editing an unfamiliar sandbox layout`,
    )
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
 * Verify the confined argv against the pinned stock layout and return it with the grant binds spliced in before the `--` separator.
 * @param confined - the argv `super.confine()` produced.
 * @param original - the exact argv that was passed to confine.
 * @param policy - the policy the wrap was built for.
 * @param binds - the validated grant binds. Ordinary grants mount a path onto itself; a private-state shadow (semgrep) mounts a writable cache directory at a different sandbox destination - both are the same `--bind source destination` shape.
 * @returns the confined argv with `--bind source destination` pairs appended after the stock profile, before `--`.
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
    throw new GrantArgvError(
      `runner is ${describe(confined[0] ?? '<empty>')}, not the stock "bwrap" — a configured runnerCommand wrapper or a non-bwrap backend cannot carry directory grants`,
    )
  }
  const expected = expectedStockProfileArgs(policy)
  for (const [index, want] of expected.entries()) {
    const got = confined[1 + index]
    if (got !== want) {
      throw new GrantArgvError(
        `profile argument ${index} is ${describe(got ?? '<missing>')}, expected ${describe(want)}`,
      )
    }
  }
  const separator = 1 + expected.length
  if (confined[separator] !== '--') {
    throw new GrantArgvError(
      `element ${separator} is ${describe(confined[separator] ?? '<missing>')}, expected the "--" separator`,
    )
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
