/** Sandbox modes, ordered by width; escalation targets are compared by rank. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** True when `mode` is one of the three sandbox widths (guard, no assertion). */
export function isSandboxMode(mode: string): mode is SandboxMode {
  return mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
}

export const MODE_RANK: Readonly<Record<SandboxMode, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/** Compiled allowlist rules; rebuilt from live settings on each decision. */
export interface CompiledRules {
  names: ReadonlySet<string>
  patterns: readonly RegExp[]
  denyShapes: readonly RegExp[]
}

/** Regexes that failed to compile, with the offending source (for logs). */
export interface CompileIssues {
  invalidPatterns: readonly string[]
  invalidDenyShapes: readonly string[]
}

/** Result of compiling the live settings into matchable rules. */
export type Compiled = CompiledRules & { issues: CompileIssues }

/** Compile one regex source, or return undefined when it does not compile. */
function tryRegExp(source: string): RegExp | undefined {
  if (source === '') return undefined
  try {
    return new RegExp(source, 'u')
  } catch {
    return undefined
  }
}

/** Compile live settings into rules; invalid regex sources are skipped and reported (Settings-editable values must never crash the answerer). */
export function compileRules(settings: {
  allow: readonly string[]
  allowPattern: readonly string[]
  denyShape: readonly string[]
}): Compiled {
  const names = new Set(settings.allow.map((name) => name.trim()).filter((name) => name !== ''))
  const invalidPatterns: string[] = []
  const patterns: RegExp[] = []
  for (const source of settings.allowPattern) {
    const re = tryRegExp(source)
    if (re === undefined) invalidPatterns.push(source)
    else patterns.push(re)
  }
  const invalidDenyShapes: string[] = []
  const denyShapes: RegExp[] = []
  for (const source of settings.denyShape) {
    const re = tryRegExp(source)
    if (re === undefined) invalidDenyShapes.push(source)
    else denyShapes.push(re)
  }
  return { names, patterns, denyShapes, issues: { invalidPatterns, invalidDenyShapes } }
}

/** True when the command contains command substitution the matcher cannot see. */
export function containsSubstitution(command: string): boolean {
  return command.includes('$(') || command.includes('`')
}

/** Split a bash command into the segments that must EACH be allowed. Extra splits are safe (each piece must then match); merges cannot happen. */
export function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

const WRAPPERS = new Set(['command', 'exec', 'env', 'nohup', 'time', 'nice', 'stdbuf'])

/** The head command name of one segment, after skipping env assignments, parens, negation, and wrappers; a path becomes its basename. Returns undefined for segments with no command at all. */
export function segmentHead(segment: string): string | undefined {
  let tokens = segment
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '')
  while (tokens.length > 0 && (tokens[0] === '(' || tokens[0] === '!' || tokens[0] === '{')) {
    tokens = tokens.slice(1)
  }
  for (;;) {
    const head = tokens[0]
    if (head === undefined) return undefined
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(head) || (tokens.length > 1 && WRAPPERS.has(head))) {
      tokens = tokens.slice(1)
      continue
    }
    if (WRAPPERS.has(head)) return undefined
    const name = head.includes('/') ? (head.split('/').pop() ?? head) : head
    return name
  }
}

/** Why a command was allowed; `kind: 'none'` defers to the rest of the chain. */
export type AllowDecision = { kind: 'allow'; via: string } | { kind: 'none' }

/** Decide whether every segment of the command is covered by the rules. Denial is NOT decided here - denyShape is tested by the caller against the complete command (see CmdPermit.isHighRisk). */
export function decideAllow(command: string, rules: CompiledRules): AllowDecision {
  if (containsSubstitution(command)) return { kind: 'none' }
  const segments = splitSegments(command)
  if (segments.length === 0) return { kind: 'none' }
  let via = ''
  for (const segment of segments) {
    if (rules.patterns.some((re) => re.test(segment))) {
      if (via === '') via = `pattern ~ ${segment}`
      continue
    }
    const head = segmentHead(segment)
    if (head !== undefined && rules.names.has(head)) {
      if (via === '') via = head
      continue
    }
    return { kind: 'none' }
  }
  return { kind: 'allow', via }
}
