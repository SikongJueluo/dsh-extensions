/**
 * Best-effort page-body extraction for the top evidence sources.
 *
 * A plain SERP snippet caps how deeply the integrator can read a page. For a
 * handful of high-ranked sources whose provider content is thin, this module
 * fetches the page itself and distills an HTML→text excerpt. Everything here
 * is opportunistic: wrong content type, oversized body, encoding surprises,
 * or a fetch failure all degrade silently to the snippet the provider gave.
 *
 * @module dsh-search-integrator/fetch-page
 */

/** A page fetcher bound to the network IO; injectable for tests. */
export type PageFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<{ readonly contentType: string; readonly body: string } | undefined>

/** Read at most this many bytes of any page before parsing. */
const MAX_BYTES = 512 * 1024

const BLOCK_TAGS = /<(script|style|noscript|svg|head|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi
const BREAK_OPEN = /<br\s*\/?>/gi
const BLOCK_CLOSE = /<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi

const BASIC_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => {
      const num = Number(code)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const num = Number.parseInt(hex, 16)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ''
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => BASIC_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * Distill an HTML document to a compact text excerpt: block-level markup is
 * dropped, tags stripped, entities decoded, whitespace collapsed. Not a
 * markdown converter — good enough for an evidence digest.
 */
export function htmlToExcerpt(html: string, cap: number): string {
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(BLOCK_TAGS, ' ')
      .replace(BREAK_OPEN, '\n')
      .replace(BLOCK_CLOSE, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/**
 * The production page fetcher over global fetch: HTML pages only, size- and
 * signal-bounded, undefined on anything that is not plainly an HTML page.
 */
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
    const reader = response.body?.getReader()
    if (reader === undefined) return undefined
    const decoder = new TextDecoder()
    let received = 0
    let body = ''
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done === true) break
      received += value.byteLength
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return { contentType, body }
  }
}
