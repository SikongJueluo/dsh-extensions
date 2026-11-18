/**
 * Thinking-level metadata shared by configured and discovered models.
 * @module dsh-more-providers/reasoning
 */
import type { ThinkingLevelMap } from '@earendil-works/pi-ai'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS)

export const DEFAULT_THINKING_LEVELS = ['low', 'medium', 'high'] as const

/**
 * Expand the declared levels into pi-ai's full map: undeclared levels become unavailable, and a declared `off` stays unset so the wire omits the effort.
 * @param levels - Levels the model offers.
 * @returns The complete thinking-level map.
 */
export function thinkingLevelMapOf(levels: readonly string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    if (!levels.includes(level)) map[level] = null
    else if (level !== 'off') map[level] = level
  }
  return map
}
