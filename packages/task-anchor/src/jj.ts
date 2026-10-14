/**
 * Read-only Jujutsu facts for the recovery anchor.
 *
 * Facts come from fixed-argv `jj` invocations (`--ignore-working-copy
 * --no-pager`), no shell, a hard timeout: one combined template read of the
 * working change id and its parents (FULL change ids — `.short()` abbreviations
 * vary and can collide as a repo grows), one workspace-root read, and a
 * second light re-read of the same combined template to detect drift. The
 * three processes are not atomic — that is exactly why the re-read exists:
 * a `jj new`/rebase landing between the reads produces mixed facts, and the
 * stability check turns that into an explicit `drift` failure instead of a
 * poisoned anchor. git is deliberately NOT used as a fallback: a non-jj root
 * reports `not-jj` and the checkpoint fails loudly.
 *
 * @module dsh-execution-guard/jj
 */
import { execFile } from 'node:child_process'

/** The facts an anchor needs: working layer ids plus the workspace root. */
export interface JjFacts {
  /** Full (non-abbreviated) change id of the working copy commit. */
  readonly changeId: string
  /** Full change ids of the working commit's parents, in template order. */
  readonly parentChangeIds: readonly string[]
  /** Absolute jj workspace root — the repo root even when cwd is a subdirectory. */
  readonly workspaceRoot: string
}

/** Outcome of one facts read; never throws. */
export type JjRead =
  | { ok: true; facts: JjFacts }
  | { ok: false; reason: 'not-jj' | 'timeout' | 'drift' | 'failed'; detail: string }

/** Injectable process runner so tests never spawn a real jj. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number | null }>

/** Default runner: `execFile` with argv only — no shell, ever. */
export const defaultExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 64 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stderr: String(stderr ?? '') }))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr ?? ''), code: 0 })
      },
    )
    void child
  })

const JJ_GLOBAL = ['--ignore-working-copy', '--no-pager'] as const

/**
 * Fixed argv reading the working change id AND its parents in ONE process:
 * full `change_id`s, parents space-joined (empty line for a parentless
 * root commit).
 */
export function workingLayerArgv(): readonly string[] {
  return [...JJ_GLOBAL, 'log', '-r', '@', '--no-graph', '-T', 'change_id ++ "\\n" ++ parents.map(|p| p.change_id()).join(" ")']
}

/** Fixed argv for the workspace root (absolute, subdirectory-proof). */
export function workspaceRootArgv(): readonly string[] {
  return [...JJ_GLOBAL, 'workspace', 'root']
}

function classify(error: unknown): JjRead {
  const err = error as { killed?: boolean; message?: string; stderr?: string }
  const detail = `${err?.message ?? ''} ${err?.stderr ?? ''}`.trim()
  if (err?.killed === true || /timed? out/i.test(detail)) {
    return { ok: false, reason: 'timeout', detail }
  }
  if (/not a jj repo|no jj repo/i.test(detail) || /No such repo/i.test(detail)) {
    return { ok: false, reason: 'not-jj', detail }
  }
  return { ok: false, reason: 'failed', detail }
}

interface LayerLine {
  readonly changeId: string
  readonly parentChangeIds: readonly string[]
}

function parseLayer(stdout: string): LayerLine | undefined {
  const lines = stdout.split('\n')
  const changeId = (lines[0] ?? '').trim()
  if (changeId === '') return undefined
  const parents = (lines[1] ?? '').trim()
  const parentChangeIds = parents === '' ? [] : parents.split(/\s+/)
  if (parentChangeIds.some((id) => id === '')) return undefined
  return { changeId, parentChangeIds }
}

/**
 * Read the working layer, the workspace root, and re-verify the layer did
 * not move mid-read. Multi-parent merges are reported as an ordered list;
 * a parentless root yields an empty list. Drift between the first read and
 * the re-read fails as `drift` — never saved as mixed facts, never retried
 * (the caller surfaces the failure and the model re-checkpoints).
 *
 * @param root - absolute directory to run jj from (session cwd, realpath'd).
 * @param exec - injectable runner (tests pass a fake; no real process).
 * @param jjPath - executable to run; argv stays fixed regardless.
 * @param timeoutMs - per-invocation budget.
 * @param signal - caller cancellation forwarded to the child.
 */
export async function readJjFacts(
  root: string,
  exec: ExecFile,
  jjPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JjRead> {
  try {
    const first = await exec(jjPath, workingLayerArgv(), { cwd: root, timeoutMs, signal })
    const workspace = await exec(jjPath, workspaceRootArgv(), { cwd: root, timeoutMs, signal })
    const recheck = await exec(jjPath, workingLayerArgv(), { cwd: root, timeoutMs, signal })
    const layer = parseLayer(first.stdout)
    const layerAgain = parseLayer(recheck.stdout)
    const workspaceRoot = workspace.stdout.trim()
    if (layer === undefined || layerAgain === undefined || workspaceRoot === '') {
      return {
        ok: false,
        reason: 'failed',
        detail: `empty or malformed jj output (first="${first.stdout.trim().slice(0, 120)}", recheck="${recheck.stdout.trim().slice(0, 120)}", workspaceRoot="${workspaceRoot}")`,
      }
    }
    if (layer.changeId !== layerAgain.changeId
      || layer.parentChangeIds.length !== layerAgain.parentChangeIds.length
      || layer.parentChangeIds.some((id, i) => id !== layerAgain.parentChangeIds[i])) {
      return {
        ok: false,
        reason: 'drift',
        detail: `working layer moved during the read (first ${layer.changeId} -> recheck ${layerAgain.changeId}); retry the checkpoint`,
      }
    }
    return {
      ok: true,
      facts: { changeId: layer.changeId, parentChangeIds: layer.parentChangeIds, workspaceRoot },
    }
  } catch (error) {
    return classify(error)
  }
}
