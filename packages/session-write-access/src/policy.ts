/**
 * Pure combination of the stock resolved policy with one authorization group.
 * Kept separate from the service so the exact rule the filesystem fence and
 * confined shell consume can be tested without composing a Host.
 *
 * @module dsh-session-write-access/policy
 */
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { GroupRecord } from './domain.js'
import { mergeWritableRoots } from './paths.js'

/**
 * Apply a group's frozen workspace and extra directories to one resolved
 * policy. Under `read-only` and `danger-full-access` the stock policy is
 * returned untouched: directory grants never turn read-only into a write
 * mode, and Full access already has its own host semantics.
 * @param base - the stock policy for this call (mode, workspace, deployment roots).
 * @param group - the session family's committed authorization group.
 * @returns the policy every enforcing family will read for this call.
 */
export function applyGroupPolicy(
  base: SandboxExecutionPolicy,
  group: Pick<GroupRecord, 'workspaceRoot' | 'grants'>,
): SandboxExecutionPolicy {
  if (base.mode !== 'workspace-write') return base
  const merged = mergeWritableRoots(base.additionalWritableRoots, group.grants.map(grant => grant.path))
  return {
    ...base,
    workspaceRoot: group.workspaceRoot,
    ...merged === undefined ? {} : { additionalWritableRoots: merged },
  }
}
