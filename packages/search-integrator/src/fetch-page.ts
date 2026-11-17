/**
 * Best-effort page-body extraction for the top evidence sources.
 * @module dsh-search-integrator/fetch-page
 */

/** A page fetcher bound to the network IO; injectable for tests. */
export type PageFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<{ readonly contentType: string; readonly body: string } | undefined>

const MAX_BYTES = 512 * 1024

const BLOCK_TAGS = /<(script|style|noscript|svg|head|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/giu
const BREAK_OPEN = /<br\s*\/?>/giu
const BLOCK_CLOSE = /<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/giu

const BASIC_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

function decodeEntities(text: string): string {
  return text
    .replaceAll(/&#(\d+);/gu, (_, code: string) => {
      const num = Number(code)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ''
    })
    .replaceAll(/&#x([0-9a-f]+);/giu, (_, hex: string) => {
      const num = Number.parseInt(hex, 16)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ''
    })
    .replaceAll(
      /&([a-z]+);/giu,
      (match, name: string) => BASIC_ENTITIES[name.toLowerCase()] ?? match,
    )
}

/** Distill an HTML document to a compact text excerpt: block-level markup is dropped, tags stripped, entities decoded, whitespace collapsed. Not a markdown converter - good enough for an evidence digest. */
export function htmlToExcerpt(html: string, cap: number): string {
  const text = decodeEntities(
    html
      .replaceAll(/<!--[\s\S]*?-->/gu, ' ')
      .replaceAll(BLOCK_TAGS, ' ')
      .replaceAll(BREAK_OPEN, '\n')
      .replaceAll(BLOCK_CLOSE, '\n')
      .replaceAll(/<[^>]+>/gu, ' '),
  )
    .replaceAll(/[ \t\f\v]+/gu, ' ')
    .replaceAll(/\n\s*\n+/gu, '\n')
    .trim()
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** The production page fetcher over global fetch: HTML pages only, size- and signal-bounded, undefined on anything that is not plainly an HTML page. */
export function fetchPage(): PageFetcher {
  return async (url, signal) => {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; dsh-search-integrator/1.0)',
      },
      signal,
    })
    if (!response.ok) return undefined
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('html')) return undefined
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader()
    if (reader === undefined) return undefined
    const decoder = new TextDecoder()
    let received = 0
    let body = ''
    while (received < MAX_BYTES) {
      const read = await reader.read()
      if (read.done) break
      received += read.value.byteLength
      body += decoder.decode(read.value, { stream: true })
    }
    body += decoder.decode()
    return { contentType, body }
  }
}
