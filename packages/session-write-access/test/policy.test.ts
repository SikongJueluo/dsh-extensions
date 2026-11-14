import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { writableRoots, workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import { applyGroupPolicy } from '../src/policy.js'

function dirs(): { root: string; a: string; b: string; c: string; deployment: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-swa-policy-'))
  const a = join(root, 'a')
  const b = join(root, 'b')
  const c = join(root, 'c')
  const deployment = join(root, 'deployment')
  for (const path of [a, b, c, deployment]) mkdirSync(path)
  return { root, a, b, c, deployment }
}

describe('group policy combination', () => {
  it('replaces the child workspace with the family root and adds grants', () => {
    const { a, b, c, deployment } = dirs()
    // The child's cwd is C; the family root is A and B is granted.
    const base: SandboxExecutionPolicy = {
      mode: 'workspace-write',
      workspaceRoot: c,
      additionalWritableRoots: [deployment],
    }
    const group = {
      workspaceRoot: a,
      grants: [{ version: 1 as const, path: b, source: 'user' as const, addedAt: 1 }],
    }
    const policy = applyGroupPolicy(base, group)
    expect(policy.workspaceRoot).toBe(a)
    expect(policy.additionalWritableRoots).toEqual([deployment, b])
    const roots = workspaceWritableRoots(policy)
    expect(roots).toContain(a)
    expect(roots).toContain(b)
    expect(roots).toContain(deployment)
    expect(roots).not.toContain(c)
    expect(writableRoots(policy)).not.toContain(c)
  })

  it('never turns read-only into a write mode and leaves full access alone', () => {
    const { a, b } = dirs()
    const readOnly: SandboxExecutionPolicy = { mode: 'read-only', workspaceRoot: a }
    const group = {
      workspaceRoot: a,
      grants: [{ version: 1 as const, path: b, source: 'user' as const, addedAt: 1 }],
    }
    expect(applyGroupPolicy(readOnly, group)).toBe(readOnly)
    expect(workspaceWritableRoots(applyGroupPolicy(readOnly, group))).toEqual([])
    const full: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: a }
    expect(applyGroupPolicy(full, group)).toBe(full)
  })

  it('leaves deployment-only policy unchanged when the group has no grants', () => {
    const { a, deployment } = dirs()
    const base: SandboxExecutionPolicy = {
      mode: 'workspace-write',
      workspaceRoot: a,
      additionalWritableRoots: [deployment],
    }
    const policy = applyGroupPolicy(base, { workspaceRoot: a, grants: [] })
    expect(policy.additionalWritableRoots).toEqual([deployment])
    expect(policy.workspaceRoot).toBe(a)
  })
})
