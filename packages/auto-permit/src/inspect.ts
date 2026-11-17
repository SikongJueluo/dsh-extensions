import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Logger } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { debugQuietly, errorTag } from './diagnostics.js'
import { isRecord } from './record.js'

export const INSPECT_LIMITS = {
  maxToolCalls: 12,

  maxOutputBytes: 32 * 1024,

  maxReadBytes: 12 * 1024,

  maxFileBytes: 256 * 1024,

  maxScanBytes: 4 * 1024 * 1024,

  maxVisitedFiles: 400,

  maxMatches: 60,

  maxListEntries: 200,

  maxPathChars: 4096,

  maxMatchLineChars: 300,
} as const

export interface InspectResult {
  text: string

  isError: boolean

  incomplete?: boolean
}

export interface InspectProblem {
  readonly category: 'budget' | 'evidence-unavailable' | 'evidence-changed'
  readonly message: string
}

export interface Inspector {
  readonly tools: readonly ToolSchema[]

  execute(name: string, argumentsJson: string): Promise<InspectResult>

  references(): readonly string[]

  changedFiles(): Promise<readonly string[]>

  problem(): InspectProblem | undefined

  invalidated(): boolean
}

const INSPECT_TOOLS: readonly ToolSchema[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the session workspace. Returns line-numbered text; results are capped.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path, or an absolute path inside the workspace.',
        },
        offset: {
          type: 'integer',
          description: '1-based first line to return; defaults to 1.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum lines to return; defaults to 400, capped at 600.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: 'List one directory in the session workspace with entry kinds and file sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace-relative directory, or an absolute path inside the workspace; defaults to the working directory.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description:
      'Case-insensitive literal text search across workspace text files; skips VCS, cache, dependency, and build directories, and files larger than 256 KiB.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Literal text to find (not a regular expression).',
        },
        path: {
          type: 'string',
          description:
            'Workspace-relative text file or directory to search; defaults to the working directory.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

const DENIED_DIRS = new Set([
  '.git',
  '.jj',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.password-store',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
])

const SEARCH_SKIP_DIRS = new Set(['dist', 'build', 'target', 'coverage'])

const DENIED_FILE =
  /^(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?$|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/iu

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function hashOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

function lineRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`
}

function isDeniedComponent(name: string): boolean {
  return DENIED_DIRS.has(name) || DENIED_FILE.test(name)
}

function clipLine(line: string): string {
  return line.length > INSPECT_LIMITS.maxMatchLineChars
    ? `${line.slice(0, INSPECT_LIMITS.maxMatchLineChars)}…`
    : line
}

function argumentObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function stringArgument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function integerArgument(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

interface Resolved {
  logical: string

  real: string

  rel: string

  logicalRel: string
}

interface ReadVersion {
  logical: string
  real: string
  logicalRel: string
  hash: string
  mtimeMs: number
  size: number
}

interface InspectorState {
  root: string
  cwd: string
  calls: number
  outputBytes: number
  refs: string[]
  reads: Map<string, ReadVersion>
  problem?: InspectProblem
  invalidated: boolean
  changed: Set<string>
}

function relativeToRoot(root: string, real: string): string {
  const rel = relative(root, real)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function denyReason(rel: string): string | undefined {
  const parts = rel.split('/')
  if (parts.some((part) => isDeniedComponent(part))) {
    return `path is not readable as approval evidence: ${rel}`
  }
  return undefined
}

export async function createInspector(
  workspace: string | undefined,
  cwd: string | undefined,
  signal?: AbortSignal,
  logger?: Pick<Logger, 'debug'>,
): Promise<Inspector | undefined> {
  if (workspace === undefined) return undefined
  signal?.throwIfAborted()
  let root: string
  try {
    root = await realpath(workspace)
    if (!(await stat(root)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  signal?.throwIfAborted()
  let base = root
  if (cwd !== undefined) {
    try {
      const resolved = await realpath(cwd)
      if (contains(root, resolved)) base = resolved
    } catch (error) {
      debugQuietly(
        logger,
        'auto-permit: cwd %s is unresolved inside the workspace; evidence resolves against the root (%s)',
        cwd,
        errorTag(error),
      )
    }
  }

  const state: InspectorState = {
    root,
    cwd: base,
    calls: 0,
    outputBytes: 0,
    refs: [],
    reads: new Map(),
    invalidated: false,
    changed: new Set(),
  }

  const markProblem = (category: InspectProblem['category'], message: string): void => {
    state.problem ??= { category, message }
  }

  const fail = (
    message: string,
    category: InspectProblem['category'] = 'evidence-unavailable',
    incomplete = false,
  ): InspectResult => {
    markProblem(category, message)
    return { text: message, isError: true, ...(incomplete ? { incomplete: true } : {}) }
  }

  const resolvePath = async (input: string): Promise<Resolved | string> => {
    signal?.throwIfAborted()
    if (input.length > INSPECT_LIMITS.maxPathChars) return 'path is too long'
    const logical = isAbsolute(input) ? resolve(input) : resolve(state.cwd, input)
    let real: string
    try {
      real = await realpath(logical)
    } catch {
      return `path is unavailable: ${input}`
    }
    if (!contains(root, real)) return `path is outside the session workspace: ${input}`
    const rel = relativeToRoot(root, real)
    const logicalRel = relativeToRoot(root, logical)
    return denyReason(rel) ?? { logical, real, rel, logicalRel }
  }

  const recordRef = (ref: string): void => {
    if (!state.refs.includes(ref)) state.refs.push(ref)
  }

  const recordRead = (
    resolved: Resolved,
    raw: Buffer,
    info: { mtimeMs: number; size: number },
  ): boolean => {
    const hash = hashOf(raw)
    const prior = state.reads.get(resolved.logical)
    if (prior === undefined) {
      state.reads.set(resolved.logical, {
        logical: resolved.logical,
        real: resolved.real,
        logicalRel: resolved.logicalRel,
        hash,
        mtimeMs: info.mtimeMs,
        size: info.size,
      })
      return true
    }
    if (prior.real !== resolved.real || prior.hash !== hash) {
      state.invalidated = true
      state.changed.add(resolved.logicalRel)
      markProblem(
        'evidence-changed',
        `evidence changed during the investigation: ${resolved.logicalRel}`,
      )
      return false
    }
    return true
  }

  const spend = (text: string, incomplete = false): InspectResult => {
    const bytes = bytesOf(text)
    if (state.outputBytes + bytes > INSPECT_LIMITS.maxOutputBytes) {
      return fail(
        `evidence output budget exhausted after ${state.outputBytes} of ${INSPECT_LIMITS.maxOutputBytes} bytes; return DEFER`,
        'budget',
        true,
      )
    }
    state.outputBytes += bytes
    if (incomplete) {
      markProblem('budget', 'evidence result was truncated or capped')
    }
    return { text, isError: false, ...(incomplete ? { incomplete: true } : {}) }
  }

  const readOne = async (args: Record<string, unknown>): Promise<InspectResult> => {
    const input = stringArgument(args, 'path')
    if (input === undefined) return fail('read_file needs a path')
    const resolved = await resolvePath(input)
    if (typeof resolved === 'string') return fail(resolved)
    const info = await stat(resolved.real)
    if (!info.isFile()) return fail(`not a regular file: ${resolved.rel}`)
    if (info.size > INSPECT_LIMITS.maxFileBytes) {
      return fail(`file is too large to read (${info.size} bytes): ${resolved.rel}`, 'budget', true)
    }
    const raw = await readFile(resolved.real, { signal })
    signal?.throwIfAborted()
    if (raw.subarray(0, 1024).includes(0)) {
      return fail(`not a UTF-8 text file: ${resolved.rel}`)
    }
    const lines = raw.toString('utf8').split('\n')
    const offset = Math.max(1, integerArgument(args, 'offset') ?? 1)
    const limit = Math.min(600, Math.max(1, integerArgument(args, 'limit') ?? 400))
    if (offset > lines.length) {
      return fail(`offset ${offset} is past the end of ${resolved.rel} (${lines.length} lines)`)
    }
    if (!recordRead(resolved, raw, info)) {
      return fail(
        `evidence changed since it was first read: ${resolved.logicalRel}`,
        'evidence-changed',
        true,
      )
    }
    const selected = lines.slice(offset - 1, offset - 1 + limit)
    let text = selected.map((line, index) => `${offset + index}: ${line}`).join('\n')
    let truncated = false
    let returned = selected.length
    if (bytesOf(text) > INSPECT_LIMITS.maxReadBytes) {
      const kept: string[] = []
      let used = 0
      for (const line of selected) {
        const next = `${offset + kept.length}: ${line}`
        if (used + bytesOf(next) + 1 > INSPECT_LIMITS.maxReadBytes) break
        kept.push(next)
        used += bytesOf(next) + 1
      }
      text = kept.join('\n')
      returned = kept.length
      truncated = true
    }
    if (truncated) text += '\n…[truncated; request a narrower offset/limit]'
    recordRef(
      `${resolved.logicalRel}:${lineRange(offset, Math.max(offset, Math.min(offset - 1 + returned, lines.length)))}`,
    )
    return spend(text, truncated)
  }

  const listOne = async (args: Record<string, unknown>): Promise<InspectResult> => {
    const input = stringArgument(args, 'path') ?? '.'
    const resolved = await resolvePath(input)
    if (typeof resolved === 'string') return fail(resolved)
    const info = await stat(resolved.real)
    if (!info.isDirectory()) return fail(`not a directory: ${resolved.rel}`)
    const entries = await readdir(resolved.real, { withFileTypes: true })
    signal?.throwIfAborted()

    const eligible = entries
      .filter((entry) => !isDeniedComponent(entry.name))
      .toSorted(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
    const visible = eligible.slice(0, INSPECT_LIMITS.maxListEntries)
    const lines: string[] = []
    for (const entry of visible) {
      if (entry.isDirectory()) {
        lines.push(`dir  ${entry.name}/`)
        continue
      }
      if (entry.isSymbolicLink()) {
        lines.push(`link ${entry.name}`)
        continue
      }
      try {
        const child = await stat(resolve(resolved.real, entry.name))
        lines.push(`file ${entry.name} (${child.size} bytes)`)
      } catch {
        lines.push(`file ${entry.name}`)
      }
    }
    const omitted = eligible.length - visible.length
    if (omitted > 0) lines.push(`…[${omitted} more entries omitted]`)
    recordRef(resolved.rel === '.' ? 'list:.' : `list:${resolved.rel}`)
    return spend(lines.join('\n'), omitted > 0)
  }

  const searchOne = async (args: Record<string, unknown>): Promise<InspectResult> => {
    const needle = stringArgument(args, 'text')
    if (needle === undefined) return fail('search_files needs literal text')
    const input = stringArgument(args, 'path') ?? '.'
    const resolved = await resolvePath(input)
    if (typeof resolved === 'string') return fail(resolved)
    const baseInfo = await stat(resolved.real)
    const needleLower = needle.toLowerCase()
    const matches: string[] = []
    let visited = 0
    let scanned = 0
    let skipped = 0
    let lineTruncated = false
    let capped = false

    const visit = async (dir: string): Promise<void> => {
      if (capped) return
      signal?.throwIfAborted()
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        markProblem(
          'evidence-unavailable',
          `cannot read directory during search: ${relativeToRoot(root, dir)}`,
        )
        capped = true
        return
      }
      entries.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
      for (const entry of entries) {
        if (capped) return
        if (isDeniedComponent(entry.name)) continue
        if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          await visit(full)
          continue
        }
        if (!entry.isFile()) continue
        visited += 1
        if (visited > INSPECT_LIMITS.maxVisitedFiles) {
          capped = true
          return
        }
        let raw: Buffer
        try {
          const fileInfo = await stat(full)
          if (fileInfo.size > INSPECT_LIMITS.maxFileBytes) {
            skipped += 1
            continue
          }
          if (scanned + fileInfo.size > INSPECT_LIMITS.maxScanBytes) {
            capped = true
            return
          }
          raw = await readFile(full, { signal })
          scanned += raw.length
          if (
            !recordRead(
              {
                logical: full,
                real: full,
                rel: relativeToRoot(root, full),
                logicalRel: relativeToRoot(root, full),
              },
              raw,
              fileInfo,
            )
          ) {
            capped = true
            return
          }
        } catch {
          skipped += 1
          continue
        }
        if (raw.subarray(0, 1024).includes(0)) {
          skipped += 1
          continue
        }
        const rel = relativeToRoot(root, full)
        const lines = raw.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? ''
          if (!line.toLowerCase().includes(needleLower)) continue
          const trimmed = line.trim()
          if (trimmed.length > INSPECT_LIMITS.maxMatchLineChars) lineTruncated = true
          matches.push(`${rel}:${i + 1}: ${clipLine(trimmed)}`)
          recordRef(`${rel}:${i + 1}`)
          if (matches.length >= INSPECT_LIMITS.maxMatches) {
            capped = true
            return
          }
        }
      }
    }

    if (baseInfo.isDirectory()) {
      await visit(resolved.real)
    } else {
      if (!baseInfo.isFile()) return fail(`not a regular file: ${resolved.rel}`)
      if (baseInfo.size > INSPECT_LIMITS.maxFileBytes) {
        return fail(
          `file is too large to search (${baseInfo.size} bytes): ${resolved.rel}`,
          'budget',
          true,
        )
      }
      const raw = await readFile(resolved.real, { signal })
      signal?.throwIfAborted()
      if (raw.subarray(0, 1024).includes(0)) {
        return fail(`not a UTF-8 text file: ${resolved.rel}`)
      }
      if (!recordRead(resolved, raw, baseInfo)) {
        return fail(
          `evidence changed since it was first read: ${resolved.logicalRel}`,
          'evidence-changed',
          true,
        )
      }
      const lines = raw.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? ''
        if (!line.toLowerCase().includes(needleLower)) continue
        const trimmed = line.trim()
        if (trimmed.length > INSPECT_LIMITS.maxMatchLineChars) lineTruncated = true
        matches.push(`${resolved.rel}:${i + 1}: ${clipLine(trimmed)}`)
        recordRef(`${resolved.rel}:${i + 1}`)
        if (matches.length >= INSPECT_LIMITS.maxMatches) {
          capped = true
          break
        }
      }
    }

    const notes: string[] = []
    if (skipped > 0) notes.push(`${skipped} large or binary file(s) skipped`)
    if (lineTruncated) notes.push('one or more matched lines were truncated')
    const note = notes.length > 0 ? `\n…[${notes.join('; ')}]` : ''
    const incomplete = capped || skipped > 0 || lineTruncated
    if (matches.length === 0) {
      return spend(
        `no matches for ${JSON.stringify(needle)}${capped ? ' (search capped)' : ''}${note}`,
        incomplete,
      )
    }
    const text =
      matches.join('\n') + (capped ? '\n…[search capped; results are incomplete]' : '') + note
    return spend(text, incomplete)
  }

  return {
    tools: INSPECT_TOOLS,
    async execute(name, argumentsJson) {
      if (state.calls >= INSPECT_LIMITS.maxToolCalls) {
        return fail(
          `tool budget exhausted (${INSPECT_LIMITS.maxToolCalls} calls); return DEFER`,
          'budget',
          true,
        )
      }
      if (state.outputBytes >= INSPECT_LIMITS.maxOutputBytes) {
        return fail(
          `evidence budget exhausted (${INSPECT_LIMITS.maxOutputBytes} bytes); return DEFER`,
          'budget',
          true,
        )
      }
      state.calls += 1
      const args = argumentObject(argumentsJson)
      if (args === undefined) return fail('tool arguments are not a JSON object')
      try {
        if (name === 'read_file') return await readOne(args)
        if (name === 'list_dir') return await listOne(args)
        if (name === 'search_files') return await searchOne(args)
        return fail(`unknown evidence tool: ${name}`)
      } catch (error) {
        if (signal?.aborted === true) throw error
        return fail(
          `evidence tool failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    references: () => [...state.refs],
    problem: () => state.problem,
    invalidated: () => state.invalidated,
    async changedFiles() {
      const changed = new Set(state.changed)
      for (const [logical, before] of state.reads) {
        let realNow: string
        try {
          realNow = await realpath(logical)
        } catch {
          changed.add(before.logicalRel)
          continue
        }
        if (realNow !== before.real) {
          changed.add(before.logicalRel)
          continue
        }
        try {
          const after = await stat(realNow)
          if (
            !after.isFile() ||
            after.mtimeMs !== before.mtimeMs ||
            after.size !== before.size ||
            after.size > INSPECT_LIMITS.maxFileBytes
          ) {
            changed.add(before.logicalRel)
            continue
          }
          const raw = await readFile(realNow, { signal })
          if (hashOf(raw) !== before.hash) changed.add(before.logicalRel)
        } catch {
          changed.add(before.logicalRel)
        }
      }
      return [...changed]
    },
  }
}
