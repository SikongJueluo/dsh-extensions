/**
 * Shared vocabulary of the research pipeline: what providers return, what the deterministic evidence layer keeps, and the canonical tool result.
 * @module dsh-search-integrator/types
 */

/** Narrow an unchecked JSON payload to a plain record without changing the downstream path: the guard is the evidence, the fields stay `unknown` and are read with the `typeof` checks the callers already have. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One raw search hit as an adapter normalized it (no cross-source identity). */
export interface RawHit {
  readonly provider: string
  readonly query: string
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly content?: string
  readonly publishedAt?: string
}

/** Evidence after deterministic merge, dedup, ranking, and numbering. */
export interface EvidenceSource {
  readonly id: number
  readonly url: string
  readonly title?: string
  readonly snippet: string
  readonly content?: string
  readonly publishedAt?: string
  providers: string[]
  queries: string[]
  readonly score: number
}

/** Evidence-support label for one integrated point. */
export type PointStatus = 'supported' | 'conflict' | 'insufficient'

/** One attributed position inside a conflict point (validated citations). */
export interface ConflictSide {
  readonly text: string
  sources: number[]
}

/** One integrated claim with its validated citations. */
export interface ResearchPoint {
  readonly text: string
  readonly status: PointStatus
  sources: number[]
  sides?: ConflictSide[]
  readonly quote?: string
  readonly citationFailed?: true
}

/** One cited source as it appears in the canonical result. */
export interface ResultSource {
  readonly id: number
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
  providers: string[]
}

/** Why one configured source did not contribute. */
export interface SourceFailure {
  readonly source: string
  readonly reason: string
}

/** Retrieval coverage facts for the coverage note and the audit. */
export interface Coverage {
  readonly rounds: number
  queries: string[]
  searched: string[]
  failed: SourceFailure[]
  readonly resultsFound: number
  readonly evidenceCount: number
}

/** Pointer to the persisted audit artifact. */
export interface AuditRef {
  readonly locator: string
  readonly retrievalHint: string
  readonly bytes: number
}

export type ResearchStatus = 'ok' | 'degraded' | 'failed'

/** Canonical tool value; also the shape the output schema declares. Array fields are deliberately mutable so the value satisfies the type `defineTool` infers from the declared output schema (the executor's contract); the pipeline never mutates them. */
export interface ResearchResult {
  readonly status: ResearchStatus
  readonly question: string
  readonly summary: string
  points: ResearchPoint[]
  unknowns: string[]
  sources: ResultSource[]
  readonly coverage: Coverage
  readonly audit?: AuditRef
  readonly degradedReason?: string
}
