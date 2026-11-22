/**
 * Model id filters: an allow list and a deny list of regular expressions deciding which
 * catalog entries reach the model picker.
 * @module dsh-more-providers/catalog/filter
 */

/** One `{ match, flags }` entry of a filter group. */
export interface ModelPattern {
  match: string
  flags?: string
}

/** The raw `filter` section of one provider. */
export interface ModelFilterConfig {
  include?: readonly ModelPattern[]
  exclude?: readonly ModelPattern[]
}

/** Compiled filter: a deny hit wins, and an empty allow list admits every id. */
export interface ModelFilter {
  keeps(id: string): boolean
  reason(id: string): 'include-miss' | 'exclude-hit' | undefined
}

function compileGroup(group: 'include' | 'exclude', patterns: readonly ModelPattern[]): RegExp[] {
  return patterns.map((pattern, index) => {
    try {
      return new RegExp(pattern.match, pattern.flags)
    } catch (error) {
      const flags = pattern.flags === undefined ? '' : `, flags "${pattern.flags}"`
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `invalid ${group} entry ${index} {match "${pattern.match}"${flags}}: ${reason}`,
        { cause: error },
      )
    }
  })
}

function matchesAny(patterns: readonly RegExp[], id: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(id)
  })
}

/**
 * Compile the filter once so later id checks only run regular expressions.
 * @throws {Error} When a pattern or its flags are not a valid regular expression.
 */
export function compileModelFilter(config: ModelFilterConfig | undefined): ModelFilter {
  const include = compileGroup('include', config?.include ?? [])
  const exclude = compileGroup('exclude', config?.exclude ?? [])
  function reason(id: string): 'include-miss' | 'exclude-hit' | undefined {
    if (matchesAny(exclude, id)) return 'exclude-hit'
    return include.length > 0 && !matchesAny(include, id) ? 'include-miss' : undefined
  }
  return { keeps: (id) => reason(id) === undefined, reason }
}

/**
 * Combine a global filter with a provider filter, keeping only ids both of them keep. A deny
 * hit on either side wins over an allow-list miss on the other, matching one filter's order.
 */
export function combineFilters(
  global: ModelFilter | undefined,
  provider: ModelFilter | undefined,
): ModelFilter | undefined {
  if (global === undefined) return provider
  if (provider === undefined) return global
  const outer = global
  const inner = provider
  function reason(id: string): 'include-miss' | 'exclude-hit' | undefined {
    const first = outer.reason(id)
    const second = inner.reason(id)
    if (first === 'exclude-hit' || second === 'exclude-hit') return 'exclude-hit'
    if (first === 'include-miss' || second === 'include-miss') return 'include-miss'
    return undefined
  }
  return { keeps: (id) => reason(id) === undefined, reason }
}
