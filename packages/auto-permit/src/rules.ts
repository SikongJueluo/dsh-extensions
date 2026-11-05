/**
 * Hard high-risk command shapes that never reach the judge model.
 *
 * A hit does NOT reject anything — it routes the approval back to the human
 * answerer (`next()`). These encode the irreversibility boundary from the pi
 * ai-bash-judge ADR work: operations that destroy unrecoverable data or
 * escalate privileges are a human decision even when the prompt names them,
 * and even when an identical command was allowed before. The shapes are
 * deliberately conservative (false positives just cost a dialog).
 *
 * The table is shared: cmd-permit's `cmdPermit.isHighRisk()` uses it as its
 * built-ins, so these shapes also cannot be claimed by a user allowlist.
 * Container-specific boundaries (compose, remote targets, privilege, host
 * namespaces, engine sockets, sensitive mounts, existing-resource lifecycle,
 * prune, push, host configuration) live in ./container.ts and are folded in
 * here so both paths enforce them.
 */
import { containerRisk } from './container.js'

/** One anchored shape: matches the whole command string case-insensitively. */
const SHAPES: RegExp[] = [
  // Discarding uncommitted work / untracked files.
  /\bgit\s+clean\b[^;|&]*-[a-zA-Z]*x/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+(?:--\s+)?\./,
  /\bgit\s+restore\b[^;|&]*\.\s*$/,
  /\bgit\s+stash\s+(?:drop|clear)\b/,
  // Rewriting published history.
  /\bgit\s+push\b[^;|&]*(--force\b|--force-with-lease\b|\s-f\b)/,
  // Privilege escalation.
  /(^|[;&|\s])sudo\b/,
  // Remote-execution pipelines.
  /\b(curl|wget)\b[^;|&]*\|\s*(ba)?sh\b/,
]

/**
 * A shell command-position `rm` token. The leading character class is what
 * separates the command from `podman run --rm`: `--rm` is preceded by `-`,
 * which is not a command boundary, so a container's disposable flag (or an
 * image name such as `localhost/app-official`) can never open a match.
 */
const RM_COMMAND = /(?:^|[\s;&|("'`])rm(?=\s)/g

/**
 * Split one command segment into shell words, dropping quote characters.
 * This is deliberately not a full shell parser: it only needs to keep `rm`
 * flags and operands from being glued to quotes. Unterminated quotes keep the
 * words gathered so far, which can only make the scan more conservative.
 */
function wordsOf(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        word += text[i + 1] ?? ''
        i += 1
      } else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      word += text[i + 1] ?? ''
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      if (word !== '') words.push(word)
      word = ''
      continue
    }
    word += ch
  }
  if (word !== '') words.push(word)
  return words
}

/** The remainder of one command unit after `start`, stopping outside quotes. */
function segmentAfter(command: string, start: number): string {
  let quote: '"' | "'" | undefined
  for (let i = start; i < command.length; i += 1) {
    const ch = command[i]
    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === ')') {
      return command.slice(start, i)
    }
  }
  return command.slice(start)
}

/** True for an `rm -f` operand outside the workspace-relative forms. */
function dangerousRemovalTarget(target: string): boolean {
  if (target === '' || target === '-') return false
  if (target.startsWith('~')) return true
  if (/^\$(?:\{HOME\b|HOME(?:\/|$))/.test(target)) return true
  if (target.startsWith('/')) return true
  return target === '..' || target.startsWith('../')
    || target.includes('/../') || target.endsWith('/..')
}

/**
 * Detect a destructive forced removal (`rm -f`/`-rf` at a command position).
 *
 * Operands are read from the command unit that starts at `rm`, not from the
 * whole string: flags belonging to another program (`podman run --rm`) and
 * image tags cannot be mistaken for `rm` flags or targets.
 */
function destructiveRemoval(command: string): boolean {
  RM_COMMAND.lastIndex = 0
  for (let match = RM_COMMAND.exec(command); match !== null; match = RM_COMMAND.exec(command)) {
    const at = match.index + match[0].indexOf('rm')
    const words = wordsOf(segmentAfter(command, at))
    if (words[0] !== 'rm') continue
    let force = false
    let endOfOptions = false
    const targets: string[] = []
    for (const word of words.slice(1)) {
      if (!endOfOptions && word === '--') {
        endOfOptions = true
        continue
      }
      if (!endOfOptions && word.startsWith('--')) {
        if (word === '--force') force = true
        continue
      }
      if (!endOfOptions && word.startsWith('-') && word.length > 1) {
        if (word.slice(1).includes('f')) force = true
        continue
      }
      targets.push(word)
    }
    if (force && targets.some(dangerousRemovalTarget)) return true
  }
  return false
}

/**
 * Test one bash command against the high-risk shapes.
 *
 * @param command - the complete bash input.
 * @returns true when the command must go to the human dialog untouched.
 */
export function isHighRisk(command: string): boolean {
  return destructiveRemoval(command)
    || SHAPES.some((shape) => shape.test(command))
    || containerRisk(command) !== undefined
}
