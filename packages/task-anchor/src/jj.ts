/**
 * Read-only Jujutsu facts for the recovery anchor.
 * @module dsh-execution-guard/jj
 */
import { execFile } from 'node:child_process'
import { isRecord } from './goal-evidence.js'

/** The facts an anchor needs: working layer ids plus the workspace root. */
export interface JjFacts {
  readonly changeId: string
  readonly parentChangeIds: readonly string[]
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

/** Default runner: `execFile` with argv only - no shell, ever. */
export const defaultExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: 1024 * 64,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure: Error & { stderr: string } = Object.assign(error, { stderr: stderr ?? '' })
          reject(failure)
          return
        }
        resolve({ stdout, stderr: stderr ?? '', code: 0 })
      },
    )
    void child
  })

const JJ_GLOBAL = ['--ignore-working-copy', '--no-pager'] as const

/** Fixed argv reading the working change id AND its parents in ONE process: full `change_id`s, parents space-joined (empty line for a parentless root commit). */
export function workingLayerArgv(): readonly string[] {
  return [
    ...JJ_GLOBAL,
    'log',
    '-r',
    '@',
    '--no-graph',
    '-T',
    'change_id ++ "\\n" ++ parents.map(|p| p.change_id()).join(" ")',
  ]
}

/** Fixed argv for the workspace root (absolute, subdirectory-proof). */
export function workspaceRootArgv(): readonly string[] {
  return [...JJ_GLOBAL, 'workspace', 'root']
}

/** Shape of the failures the classifier reads. The predicate only proves it is a record - the declared field types let the template below keep the exact implicit-stringification behavior the classifier has always had. */
interface FailureLike {
  readonly killed?: boolean
  readonly message?: string
  readonly stderr?: string
}

function isFailureLike(value: unknown): value is FailureLike {
  return isRecord(value)
}

function classify(error: unknown): JjRead {
  const err = isFailureLike(error) ? error : undefined
  const detail = `${err?.message ?? ''} ${err?.stderr ?? ''}`.trim()
  if (err?.killed === true || /timed? out/iu.test(detail)) {
    return { ok: false, reason: 'timeout', detail }
  }
  if (/not a jj repo|no jj repo/iu.test(detail) || /No such repo/iu.test(detail)) {
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
  const parentChangeIds = parents === '' ? [] : parents.split(/\s+/u)
  if (parentChangeIds.some((id) => id === '')) return undefined
  return { changeId, parentChangeIds }
}

/**
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
    if (
      layer.changeId !== layerAgain.changeId ||
      layer.parentChangeIds.length !== layerAgain.parentChangeIds.length ||
      layer.parentChangeIds.some((id, i) => id !== layerAgain.parentChangeIds[i])
    ) {
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
