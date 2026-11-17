/** @module dsh-remote-exec/display */

/** One bounded, cleaned stream view. */
export interface DisplayView {
  readonly text: string
  readonly truncated: boolean
}

const ANSI_PATTERN =
  // oxlint-disable-next-line eslint/no-control-regex -- the pattern exists to match ANSI escapes
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-_])/gu

const MARKER_RESERVE = 64

/** Render `raw` for the model under `budgetBytes` (the plugin config minimum is 1024, above the marker reserve). The result fits the budget after the hard cap trims any UTF-8 boundary expansion; a budget below the marker size cannot fit the marker. */
export function formatDisplay(raw: string, budgetBytes: number): DisplayView {
  const budget = Math.max(1, budgetBytes)
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.length <= budget) {
    const text = clean(raw)
    if (Buffer.byteLength(text, 'utf8') <= budget) return { text, truncated: false }
    return { text: hardCap(text, budget), truncated: true }
  }
  const contentBudget = Math.max(1, budget - MARKER_RESERVE)
  const headBudget = Math.floor(contentBudget / 4)
  const tailBudget = contentBudget - headBudget
  const head = cutHead(bytes.subarray(0, headBudget).toString('utf8'))
  const tail = cutTail(bytes.subarray(bytes.length - tailBudget).toString('utf8'))
  const omitted = Math.max(
    0,
    bytes.length - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'),
  )
  const excerpt = `${head}\n[... ${omitted} bytes omitted ...]\n${tail}`
  const text = clean(excerpt)
  return {
    text: Buffer.byteLength(text, 'utf8') <= budget ? text : hardCap(text, budget),
    truncated: true,
  }
}

/** Drop a partial last line from a head slice (keep the slice if it has no newline). */
function cutHead(text: string): string {
  const at = text.lastIndexOf('\n')
  return at > 0 ? text.slice(0, at + 1) : text
}

/** Drop a partial first line from a tail slice (keep the slice if it has no newline). */
function cutTail(text: string): string {
  const at = text.indexOf('\n')
  return at >= 0 && at < text.length - 1 ? text.slice(at + 1) : text
}

function clean(text: string): string {
  const withoutAnsi = text.replaceAll(ANSI_PATTERN, '')
  const lines = withoutAnsi.split('\n').map((line) => collapseCarriage(line))
  return dedupe(lines).join('\n')
}

/** Keep the last non-empty carriage-return segment (progress-bar overwrite). */
function collapseCarriage(line: string): string {
  if (!line.includes('\r')) return line
  const segments = line.split('\r').filter((segment) => segment !== '')
  return segments.at(-1) ?? ''
}

/** Fold runs of exactly identical consecutive lines, appending the count. */
function dedupe(lines: readonly string[]): string[] {
  const out: string[] = []
  let previous: string | undefined
  let count = 0
  const flush = (): void => {
    if (previous === undefined) return
    out.push(count > 1 && previous !== '' ? `${previous} [x${count}]` : previous)
  }
  for (const line of lines) {
    if (line === previous) {
      count += 1
      continue
    }
    flush()
    previous = line
    count = 1
  }
  flush()
  return out
}

/** Hard byte cap with a head/tail marker; used when cleaning expands the text. */
function hardCap(text: string, budgetBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= budgetBytes) return text
  const marker = '\n[... display capped ...]\n'
  const contentBudget = Math.max(0, budgetBytes - Buffer.byteLength(marker, 'utf8'))
  const headBudget = Math.floor(contentBudget / 4)
  const tailBudget = contentBudget - headBudget
  const head = bytes.subarray(0, headBudget).toString('utf8')
  let tail = bytes.subarray(bytes.length - tailBudget).toString('utf8')
  let result = `${head}${marker}${tail}`
  while (Buffer.byteLength(result, 'utf8') > budgetBytes && tail.length > 0) {
    tail = tail.slice(0, -1)
    result = `${head}${marker}${tail}`
  }
  return result
}
