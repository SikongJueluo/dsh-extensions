/**
 * Pure pieces of the rewrite decision, exported for tests.
 * @module dsh-rtk-rewrite/rewrite
 */

/**
 * Extract the rewritten command from `rtk rewrite` stdout.
 * @param text - the complete captured stdout.
 * @returns the rewritten command, or undefined when stdout is empty or not a single clean line (diagnostics, multi-line output -> run unrewritten).
 */
export function rewrittenFromStdout(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.includes('\n')) return undefined
  return trimmed
}

/** Bounded command->rewrite memo. `null` stores a checked "no rewrite" answer so repeated commands never re-query rtk; insertion-order eviction keeps the working set capped. */
export class RewriteCache {
  private readonly map = new Map<string, string | null>()

  /** @param capacity - maximum cached commands (both rewritten and null). */
  constructor(private readonly capacity: number) {}

  /**
   * Look up one command.
   * @param command - the original command string.
   * @returns the cached answer, or undefined on a miss.
   */
  get(command: string): string | null | undefined {
    const hit = this.map.get(command)
    if (hit === undefined) return undefined
    this.map.delete(command)
    this.map.set(command, hit)
    return hit
  }

  /**
   * Store one answer.
   * @param command - the original command string.
   * @param rewritten - the rewritten command, or null for "no rewrite".
   */
  set(command: string, rewritten: string | null): void {
    this.map.delete(command)
    this.map.set(command, rewritten)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  // fallow-ignore-next-line unused-class-member -- only the .mjs smoke reads it; fallow cannot attribute a JS call site
  get size(): number {
    return this.map.size
  }
}
