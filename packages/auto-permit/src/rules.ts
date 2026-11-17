import { containerRisk } from './container.js'

const SHAPES: RegExp[] = [
  /\bgit\s+clean\b[^;|&]*-[a-zA-Z]*x/u,
  /\bgit\s+reset\s+--hard\b/u,
  /\bgit\s+checkout\s+(?:--\s+)?\./u,
  /\bgit\s+restore\b[^;|&]*\.\s*$/u,
  /\bgit\s+stash\s+(?:drop|clear)\b/u,

  /\bgit\s+push\b[^;|&]*(--force\b|--force-with-lease\b|\s-f\b)/u,

  /(^|[;&|\s])sudo\b/u,

  /\b(curl|wget)\b[^;|&]*\|\s*(ba)?sh\b/u,
]

const RM_COMMAND = /(?:^|[\s;&|("'`])rm(?=\s)/gu

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
    if (/\s/u.test(ch)) {
      if (word !== '') words.push(word)
      word = ''
      continue
    }
    word += ch
  }
  if (word !== '') words.push(word)
  return words
}

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

function dangerousRemovalTarget(target: string): boolean {
  if (target === '' || target === '-') return false
  if (target.startsWith('~')) return true
  if (/^\$(?:\{HOME\b|HOME(?:\/|$))/u.test(target)) return true
  if (target.startsWith('/')) return true
  return (
    target === '..' || target.startsWith('../') || target.includes('/../') || target.endsWith('/..')
  )
}

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
    if (force && targets.some((target) => dangerousRemovalTarget(target))) return true
  }
  return false
}

export function isHighRisk(command: string): boolean {
  return (
    destructiveRemoval(command) ||
    SHAPES.some((shape) => shape.test(command)) ||
    containerRisk(command) !== undefined
  )
}
