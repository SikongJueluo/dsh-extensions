/**
 * Shared vocabulary of the research pipeline: what providers return, what the
 * deterministic evidence layer keeps, and the canonical tool result.
 *
 * @module dsh-search-integrator/types
 */

/** One raw search hit as an adapter normalized it (no cross-source identity). */
export interface RawHit {
  /** Provider id that produced the hit (`tavily`, `exa`, `zhipu`, …). */
  readonly provider: string
  /** The query that surfaced the hit. */
  readonly query: string
  readonly url: string
  readonly title?: string
  /** Short provider snippet. */
  readonly snippet?: string
  /** Longer provider-supplied content, when the provider offers one. */
  readonly content?: string
  /** Provider-reported publication date, format unchecked. */
  readonly publishedAt?: string
}

/** Evidence after deterministic merge, dedup, ranking, and numbering. */
export interface EvidenceSource {
  /** Citation number shown to the integrator model and in the result, 1-based. */
  readonly id: number
  readonly url: string
  readonly title?: string
  /** Best available short text (longest snippet across providers). */
  readonly snippet: string
  /** Longer content, capped at the excerpt budget. */
  readonly content?: string
  readonly publishedAt?: string
  /** Provider ids that returned this URL (cross-source agreement). */
  readonly providers: readonly string[]
  /** Queries that surfaced this URL. */
  readonly queries: readonly string[]
  /** Deterministic rank score; higher is better. */
  readonly score: number
}

/** Evidence-support label for one integrated point. */
export type PointStatus = 'supported' | 'conflict' | 'insufficient'

/** One attributed position inside a conflict point (validated citations). */
export interface ConflictSide {
  readonly text: string
  readonly sources: readonly number[]
}

/** One integrated claim with its validated citations. */
export interface ResearchPoint {
  readonly text: string
  readonly status: PointStatus
  /** Valid evidence ids (already checked against the evidence numbering). */
  readonly sources: readonly number[]
  /** Present on conflict points that arrived as attributed sides. */
  readonly sides?: readonly ConflictSide[]
  /** Short verbatim support excerpt (audit-only; never rendered to the model). */
  readonly quote?: string
  /** Set when the model cited ids that do not exist and none survived. */
  readonly citationFailed?: true
}

/** One cited source as it appears in the canonical result. */
export interface ResultSource {
  readonly id: number
  readonly url: string
  readonly title?: string
  /** Compact snippet (capped), so a degraded/unintegrated render stays useful. */
  readonly snippet?: string
  readonly publishedAt?: string
  readonly providers: readonly string[]
}

/** Why one configured source did not contribute. */
export interface SourceFailure {
  readonly source: string
  readonly reason: string
}

/** Retrieval coverage facts for the coverage note and the audit. */
export interface Coverage {
  readonly rounds: number
  readonly queries: readonly string[]
  /** Provider ids that returned at least one usable hit. */
  readonly searched: readonly string[]
  /** Configured-but-failed or unconfigured provider ids with reasons. */
  readonly failed: readonly SourceFailure[]
  /** Raw hits before dedup. */
  readonly resultsFound: number
  /** Deduplicated evidence entries after the cap. */
  readonly evidenceCount: number
}

/** Pointer to the persisted audit artifact. */
export interface AuditRef {
  readonly locator: string
  readonly retrievalHint: string
  readonly bytes: number
}

/**
 * Overall outcome class:
 * - `ok` — integrated synthesis produced (individual source gaps allowed).
 * - `degraded` — no synthesis available; a clearly labeled, deterministically
 *   deduplicated digest stands in. Never silently equals a raw dump.
 * - `failed` — nothing usable was produced (no sources, no results, aborted
 *   integrator with zero evidence…). The summary explains why.
 */
export type ResearchStatus = 'ok' | 'degraded' | 'failed'

/** Canonical tool value; also the shape the output schema declares. */
export interface ResearchResult {
  readonly status: ResearchStatus
  readonly question: string
  readonly summary: string
  readonly points: readonly ResearchPoint[]
  readonly unknowns: readonly string[]
  readonly sources: readonly ResultSource[]
  readonly coverage: Coverage
  readonly audit?: AuditRef
  /** Present on `degraded`/`failed`: the concrete reason. */
  readonly degradedReason?: string
}

/** Aggregated token usage of the auxiliary model calls (audit-only). */
export interface UsageTotals {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
}
