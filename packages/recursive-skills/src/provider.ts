/**
 * Supplemental skill provider for bundles nested under category directories.
 * @module dsh-recursive-skills/provider
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
  SkillSource,
  SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { parseSkillDocument, type ParsedSkill } from './frontmatter.js'
import { SkillWatcher } from './watch.js'

const SKILL_FILE = 'SKILL.md'
const NESTED_DEPTH = 2
const MAX_SETTLE_PASSES = 3

/** One scanned root plus the catalog source its candidates report. */
export interface RootSpec {
  readonly path: string
  readonly source: SkillSource
}

/** Runtime configuration after schema defaults are applied. */
export interface ProviderConfig {
  readonly providerName: string
  readonly roots: readonly RootSpec[]
  readonly maxDepth: number
  readonly rank: number
  readonly watch: boolean
}

/** Opaque candidate handle passed back by the registry on load. */
interface SkillLocator {
  readonly path: string
  readonly directory: string
}

/** Narrow the opaque provider handle back to this provider's own locator. */
function isSkillLocator(value: unknown): value is SkillLocator {
  if (typeof value !== 'object' || value === null) return false
  return (
    'path' in value &&
    typeof value.path === 'string' &&
    'directory' in value &&
    typeof value.directory === 'string'
  )
}

interface ScanState {
  readonly candidates: SkillCandidate[]
  readonly watchTargets: FsTarget[]
  readonly names: Map<string, string>
  readonly visited: Set<string>
  complete: boolean
}

interface PendingDirectory {
  readonly target: FsTarget
  readonly depth: number
  readonly root: RootSpec
}

/** Recursive, catalog-compatible provider over configured skill roots. */
export class RecursiveSkillProvider implements SkillProvider {
  readonly name: string
  private readonly ctx: Context
  private readonly fs: FileSystem
  private readonly roots: readonly RootSpec[]
  private readonly maxDepth: number
  private readonly rank: number
  private readonly watcher: SkillWatcher | undefined
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, control: SkillProviderControl, config: ProviderConfig) {
    this.ctx = ctx
    this.fs = ctx.fs
    this.name = config.providerName
    this.roots = config.roots
    this.maxDepth = config.maxDepth
    this.rank = config.rank
    this.watcher = config.watch
      ? new SkillWatcher(ctx, ctx.fs, () => control.invalidate())
      : undefined
    control.signal.addEventListener('abort', () => void this.dispose(), { once: true })
  }

  /** Discover every nested bundle under the configured roots. Discovery is cancellation-aware and degrades to an incomplete observation when one directory or file cannot be read, so a single I/O fault never looks like "all nested skills were deleted". */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    let state = await this.scan(options)
    if (this.watcher === undefined) return observation(state)

    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
      const opened = await this.watcher.reconcile(state.watchTargets)
      if (!opened) return observation(state)
      state = await this.scan(options)
    }
    return { candidates: state.candidates, complete: false }
  }

  /** Load the current body of the selected candidate. Routing fields come from the live frontmatter; a name change is detected by the registry, which invalidates the cached catalog. */
  async get(
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator
    if (!isSkillLocator(locator)) return undefined
    options.signal?.throwIfAborted()
    let target: FsTarget
    try {
      target = await this.fs.resolve(locator.path, { signal: options.signal })
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsent(error)) return undefined
      throw error
    }
    options.signal?.throwIfAborted()

    let info: FsInfo | undefined
    try {
      info = await this.fs.stat(target, options.signal)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsent(error)) return undefined
      throw error
    }
    if (info === undefined || info.type !== 'file') return undefined

    let raw: string
    try {
      raw = await this.fs.readText(target, options.signal)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsent(error) || isNotText(error)) {
        this.warn(`${locator.path}: ${String(error)}`)
        return undefined
      }
      throw error
    }
    const parsed = parseSkillDocument(raw)
    if (!parsed.ok) {
      this.warn(`${locator.path} ignored: ${parsed.reason}`)
      return undefined
    }
    return {
      ...summary(
        parsed.skill,
        candidate.source,
        this.name,
        locator.directory,
        this.fs.processPath(target),
      ),
      content: parsed.skill.content,
    }
  }

  /** Close watchers and ignore late callbacks. Idempotent. */
  dispose(): Promise<void> {
    this.disposal ??= this.watcher?.close() ?? Promise.resolve()
    return this.disposal
  }

  /** One breadth-first pass over the roots. Breadth-first order is what keeps duplicate resolution stable: shallower real paths are seen before deeper symlink aliases, so `visited` cannot let an alias consume the depth budget of a real directory that the scan would have reached directly. */
  private async scan(options: SkillLookupOptions): Promise<ScanState> {
    const state: ScanState = {
      candidates: [],
      watchTargets: [],
      names: new Map(),
      visited: new Set(),
      complete: true,
    }
    const queue: PendingDirectory[] = []

    for (const root of this.roots) {
      options.signal?.throwIfAborted()
      let target: FsTarget
      try {
        target = await this.fs.resolve(root.path, { signal: options.signal })
      } catch (error) {
        options.signal?.throwIfAborted()
        if (isAbsent(error)) continue
        this.warn(`${root.path}: ${String(error)}`)
        state.complete = false
        continue
      }
      queue.push({ target, depth: 0, root })
    }

    for (let index = 0; index < queue.length; index += 1) {
      const pending = queue[index]
      if (pending === undefined) break
      const { target, depth, root } = pending
      options.signal?.throwIfAborted()
      if (state.visited.has(target.targetKey)) continue
      state.visited.add(target.targetKey)

      const info = await this.stat(target, state, options)
      if (info === undefined) {
        if (depth === 0) state.watchTargets.push(target)
        continue
      }
      if (info.type !== 'directory') continue

      const entries = await this.listDir(target, state, options)
      if (entries === undefined) continue

      const skillFile = entries.find((entry) => entry.name === SKILL_FILE && entry.type === 'file')
      if (skillFile !== undefined) {
        state.watchTargets.push(target)
        if (depth >= NESTED_DEPTH) await this.record(target, skillFile.target, root, state, options)
        continue
      }

      state.watchTargets.push(target)
      if (depth >= this.maxDepth) continue
      for (const entry of entries) {
        if (entry.type !== 'directory') continue
        queue.push({ target: entry.target, depth: depth + 1, root })
      }
    }

    return state
  }

  private async record(
    directory: FsTarget,
    file: FsTarget,
    root: RootSpec,
    state: ScanState,
    options: SkillLookupOptions,
  ): Promise<void> {
    let raw: string
    try {
      raw = await this.fs.readText(file, options.signal)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsent(error)) return
      if (isNotText(error)) {
        this.warn(`${file.displayPath} ignored: ${String(error)}`)
        return
      }
      this.warn(`${file.displayPath}: ${String(error)}`)
      state.complete = false
      return
    }
    options.signal?.throwIfAborted()

    const parsed = parseSkillDocument(raw)
    if (!parsed.ok) {
      this.warn(`${file.displayPath} ignored: ${parsed.reason}`)
      return
    }
    const duplicate = state.names.get(parsed.skill.name)
    if (duplicate !== undefined) {
      this.warn(
        `duplicate skill name "${parsed.skill.name}"; keeping ${duplicate}, ignoring ${file.displayPath}`,
      )
      return
    }
    state.names.set(parsed.skill.name, file.displayPath)
    state.candidates.push({
      ...summary(
        parsed.skill,
        root.source,
        this.name,
        directory.displayPath,
        this.fs.processPath(file),
      ),
      rank: this.rank,
      locator: { path: file.displayPath, directory: directory.displayPath } satisfies SkillLocator,
    })
  }

  private async stat(
    target: FsTarget,
    state: ScanState,
    options: SkillLookupOptions,
  ): Promise<FsInfo | undefined> {
    try {
      return await this.fs.stat(target, options.signal)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsent(error)) return undefined
      this.warn(`${target.displayPath}: ${String(error)}`)
      state.complete = false
      return undefined
    }
  }

  private async listDir(
    target: FsTarget,
    state: ScanState,
    options: SkillLookupOptions,
  ): Promise<readonly FsDirEntry[] | undefined> {
    try {
      return await this.fs.listDir(target, options.signal)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsent(error)) return []
      this.warn(`${target.displayPath}: ${String(error)}`)
      state.complete = false
      return undefined
    }
  }

  private warn(message: string): void {
    this.ctx.logger.warn(`recursive-skills: ${message}`)
  }
}

function observation(state: ScanState): SkillCandidate[] | SkillProviderObservation {
  return state.complete ? state.candidates : { candidates: state.candidates, complete: false }
}

/** Build the routing fields shared by the candidate and the loaded definition. */
function summary(
  skill: ParsedSkill,
  source: SkillSource,
  provider: string,
  directory: string,
  path: string,
): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: skill.invocation,
    source,
    provider,
    resourceBase: { kind: 'directory', path: directory },
    path,
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

function isAbsent(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'FS_NOT_FOUND' || code === 'FS_NOT_DIRECTORY' || code === 'FS_NOT_REGULAR_FILE'
}

function isNotText(error: unknown): boolean {
  return errorCode(error) === 'FS_NOT_TEXT'
}
