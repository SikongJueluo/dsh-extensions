/**
 * The deterministic evidence layer: URL-keyed dedup, syndication merging,
 * ranking, and the numbered digest the integrator model reads.
 *
 * Dedup discipline (product decision, not tuning): merge ONLY on identity we
 * can defend — the same normalized URL, or a byte-identical title+snippet
 * pair (verbatim syndication). Query strings and fragments are kept except a
 * fixed list of well-known tracking parameters; near-duplicate titles or
 * similar snippets NEVER merge, because version, number, date, and negation
 * differences live exactly there.
 *
 * @module dsh-search-integrator/evidence
 */
import type { EvidenceSource, RawHit } from './types.js'

/**
 * Tracking parameters safe to strip for identity: well-known analytics/share
 * markers that do not select content. Deliberately a short, fixed list —
 * anything not here stays part of the dedup key.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'fbclid', 'gclid', 'msclkid', 'igshid', 'mc_cid',
  'mc_eid', 'spm', 'scm', 'vd_source', 'ref_src', 'ref_url',
])

/**
 * Canonical dedup key for one URL: lowercase scheme/host, default ports and
 * tracking parameters dropped. The FRAGMENT STAYS — hash-routed SPAs serve
 * different content per fragment, and merging them would silently drop
 * evidence. Query ORDER is preserved — reordering is not identity.
 * Unparseable URLs key on their raw string.
 */
export function urlDedupKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.protocol = parsed.protocol.toLowerCase()
    parsed.hostname = parsed.hostname.toLowerCase()
    if ((parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = ''
    }
    const kept: [string, string][] = []
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value])
    }
    parsed.search = ''
    for (const [key, value] of kept) parsed.searchParams.append(key, value)
    return parsed.toString()
  } catch {
    return url
  }
}

/** Verbatim-syndication key: identical title AND the COMPLETE snippet. */
function syndicationKey(hit: RawHit): string | undefined {
  if (hit.title === undefined || hit.title === '' || hit.snippet === undefined) return undefined
  return `${hit.title}\u0000${hit.snippet.trim()}`
}

interface Working {
  url: string
  urlKey: string
  title?: string
  snippet: string
  content?: string
  publishedAt?: string
  providers: Set<string>
  queries: Set<string>
  order: number
}

function absorb(target: Working, hit: RawHit): void {
  if (target.title === undefined && hit.title !== undefined && hit.title !== '') {
    target.title = hit.title
  }
  if ((hit.snippet ?? '').length > target.snippet.length) target.snippet = hit.snippet ?? ''
  if ((hit.content ?? '').length > (target.content ?? '').length) target.content = hit.content
  if (target.publishedAt === undefined && hit.publishedAt !== undefined) {
    target.publishedAt = hit.publishedAt
  }
  target.providers.add(hit.provider)
  target.queries.add(hit.query)
}

/** Merge raw hits into unique evidence entries (URL key, then syndication key). */
function mergeRawHits(hits: readonly RawHit[]): Working[] {
  const byUrl = new Map<string, Working>()
  let order = 0
  for (const hit of hits) {
    const key = urlDedupKey(hit.url)
    const existing = byUrl.get(key)
    if (existing === undefined) {
      byUrl.set(key, {
        url: hit.url,
        urlKey: key,
        title: hit.title,
        snippet: hit.snippet ?? '',
        content: hit.content,
        publishedAt: hit.publishedAt,
        providers: new Set([hit.provider]),
        queries: new Set([hit.query]),
        order: order++,
      })
    } else {
      absorb(existing, hit)
    }
  }
  // Second pass: byte-identical title+snippet from different URLs (verbatim
  // syndication) collapses into the earliest entry. Everything else stays.
  const bySyndication = new Map<string, Working>()
  const merged: Working[] = []
  for (const entry of [...byUrl.values()].sort((a, b) => a.order - b.order)) {
    const key = syndicationKey({
      provider: '', query: '', url: entry.url,
      title: entry.title, snippet: entry.snippet,
    })
    if (key === undefined) {
      merged.push(entry)
      continue
    }
    const existing = bySyndication.get(key)
    if (existing === undefined) {
      bySyndication.set(key, entry)
      merged.push(entry)
    } else {
      for (const provider of entry.providers) existing.providers.add(provider)
      for (const query of entry.queries) existing.queries.add(query)
      if ((entry.content ?? '').length > (existing.content ?? '').length) {
        existing.content = entry.content
      }
    }
  }
  return merged
}

/** Tokenize for overlap scoring: word tokens incl. CJK runs, lowercased. */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Deterministic score: cross-source agreement first, question/query term
 * overlap second. No recency guessing — dates stay visible in the digest for
 * the integrator to reason about.
 */
function score(entry: Working, terms: ReadonlySet<string>): number {
  const haystack = `${entry.title ?? ''} ${entry.snippet} ${entry.url}`.toLowerCase()
  let overlap = 0
  for (const term of terms) {
    if (haystack.includes(term)) overlap += 1
  }
  return entry.providers.size * 3 + Math.min(4, overlap)
}

/**
 * Deduplicate, rank, cap, and number the evidence pool.
 *
 * After slicing to `cap`, at most one dropped entry whose DOMAIN appears
 * nowhere in the kept set is re-admitted. This is a domain-diversity
 * heuristic, NOT verified counter-evidence detection — it only widens what
 * the integrator can see; it cannot know whether the page dissents.
 *
 * @param hits - every raw hit from all rounds.
 * @param terms - question + query tokens for overlap scoring.
 * @param cap - `maxEvidence`: entries kept after ranking.
 * @returns numbered evidence, highest score first; stable on input order.
 */
export function buildEvidence(
  hits: readonly RawHit[],
  terms: Iterable<string>,
  cap: number,
): EvidenceSource[] {
  const termSet = new Set([...terms].map((term) => term.toLowerCase()).filter((term) => term.length > 1))
  const ranked = mergeRawHits(hits)
    .map((entry) => ({ entry, score: score(entry, termSet) }))
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
  const limit = Math.max(1, cap)
  const kept = ranked.slice(0, limit)
  const domainOf = (url: string): string => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return url
    }
  }
  const keptDomains = new Set(kept.map(({ entry }) => domainOf(entry.url)))
  const dissent = ranked.slice(limit).find(({ entry, score }) =>
    score > 0 && !keptDomains.has(domainOf(entry.url)))
  if (dissent !== undefined) kept.push(dissent)
  return kept.map(({ entry, score }, index) => ({
    id: index + 1,
    url: entry.url,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    snippet: entry.snippet,
    ...(entry.content === undefined || entry.content === '' ? {} : { content: entry.content }),
    ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
    providers: [...entry.providers],
    queries: [...entry.queries],
    score,
  }))
}

/** The excerpt one source contributes to the digest: content first, snippet fallback. */
export function excerptOf(source: EvidenceSource, cap: number): string {
  const text = source.content !== undefined && source.content !== ''
    ? source.content
    : source.snippet
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** Facts the integrator needs to judge the retrieval boundary. */
export interface RetrievalContext {
  readonly searchedAt: string
  readonly queries: readonly string[]
  readonly searched: readonly string[]
  readonly failed: readonly { source: string; reason: string }[]
}

/**
 * The retrieval-context header for the integrator digest. Retrieval time and
 * content freshness are deliberately separate facts: the header says when we
 * searched, never that content is current up to that date.
 */
export function buildRetrievalContext(context: RetrievalContext): string {
  return [
    `Retrieval context:`,
    `- searched at: ${context.searchedAt} (retrieval time only — NOT a content-freshness guarantee; each source's own date follows)`,
    `- queries: ${context.queries.join(' | ')}`,
    `- search entries responded: ${context.searched.join(', ')}${context.searched.length === 0 ? 'none' : ''}`,
    `- failed entries: ${context.failed.length === 0 ? 'none' : context.failed.map((f) => `${f.source} (${f.reason.slice(0, 80)})`).join('; ')}`,
    `- excerpt provenance: provider snippets or fetched page bodies; "…" marks truncation; "(excerpt omitted…)" entries are URL-only — title/URL known, content NOT retrieved`,
  ].join('\n')
}

/**
 * Render the numbered digest the integrator model reads. Every selected
 * source keeps at least a URL line even when the character budget runs out —
 * citation numbers must stay resolvable — while excerpts shrink first.
 *
 * @param sources - numbered evidence.
 * @param excerptChars - per-source excerpt cap.
 * @param charBudget - total digest budget.
 */
export function buildDigest(
  sources: readonly EvidenceSource[],
  excerptChars: number,
  charBudget: number,
): string {
  const lines: string[] = []
  let used = 0
  let budgetExhausted = false
  // Fair-share excerpt budget: every source gets a floor share of the digest
  // before any long excerpt can claim the rest, so one verbose source cannot
  // push later sources down to URL-only lines.
  const perSourceCap = Math.max(
    240,
    Math.min(excerptChars, Math.floor((charBudget * 0.8) / Math.max(1, sources.length))),
  )
  for (const source of sources) {
    const header = `[${source.id}] ${source.url}`
    const meta = [
      source.title ?? '',
      source.publishedAt === undefined ? 'date unknown' : `published ${source.publishedAt}`,
      `via ${source.providers.join('+')}`,
    ].filter((part) => part !== '').join(' — ')
    const headerBlock = meta === '' ? header : `${header}\n    ${meta}`
    lines.push(headerBlock)
    used += headerBlock.length
    if (budgetExhausted) {
      lines.push('    (excerpt omitted: digest budget reached)')
      continue
    }
    let excerpt = excerptOf(source, Math.min(excerptChars, perSourceCap))
    const room = charBudget - used - 40 // leave slack for separators
    if (room <= 0) {
      budgetExhausted = true
      lines.push('    (excerpt omitted: digest budget reached)')
      continue
    }
    if (excerpt.length > room) {
      excerpt = `${excerpt.slice(0, Math.max(0, room))}…`
      budgetExhausted = true
    }
    used += excerpt.length
    lines.push(`    ${excerpt}`)
  }
  return lines.join('\n')
}
