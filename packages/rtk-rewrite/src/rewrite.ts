/**
 * Pure pieces of the rewrite decision, exported for tests.
 *
 * The `rtk rewrite` contract this plugin relies on: stdout carries the
 * rewritten command (no trailing decorations), and an absent stdout means
 * "no rtk equivalent". Exit codes are deliberately NOT consulted — rtk
 * 0.49.0 returns 3 for a successful rewrite and 1 for no equivalent, which
 * already disagrees with its own docs (documented 0/2/3); stdout presence is
 * the only stable signal across versions.
 *
 * @module dsh-rtk-rewrite/rewrite
 */

/**
 * Extract the rewritten command from `rtk rewrite` stdout.
 *
 * @param text - the complete captured stdout.
 * @returns the rewritten command, or undefined when stdout is empty or not a
 * single clean line (diagnostics, multi-line output → run unrewritten).
 */
export function rewrittenFromStdout(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.includes('\n')) return undefined
  return trimmed
}

/**
 * Bounded command→rewrite memo. `null` stores a checked "no rewrite" answer
 * so repeated commands never re-query rtk; insertion-order eviction keeps the
 * working set capped.
 */
export class RewriteCache {
  private readonly map = new Map<string, string | null>()

  /**
   * @param capacity - maximum cached commands (both rewritten and null).
   */
  constructor(private readonly capacity: number) {}

  /**
   * Look up one command.
   *
   * @param command - the original command string.
   * @returns the cached answer, or undefined on a miss.
   */
  get(command: string): string | null | undefined {
    const hit = this.map.get(command)
    if (hit === undefined) return undefined
    // Refresh insertion order so eviction is LRU-ish.
    this.map.delete(command)
    this.map.set(command, hit)
    return hit
  }

  /**
   * Store one answer.
   *
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

  /** Cached entry count. */
  get size(): number {
    return this.map.size
  }
}
