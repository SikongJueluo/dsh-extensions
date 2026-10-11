/**
 * The bounded research pipeline: plan → multi-source retrieval → deterministic
 * evidence → integration → one optional follow-up round → result.
 *
 * Failure semantics (product decisions):
 * - single-source failures continue; the gap is recorded in `coverage.failed`;
 * - zero usable sources or zero results → `failed` with an explicit reason —
 *   never a silent success;
 * - a dead or unusable integrator → `degraded`: a clearly labeled,
 *   deterministically deduplicated digest, never an unmarked raw dump;
 * - every network and model call shares one wall-clock budget derived from
 *   the tool's `exec.signal`.
 *
 * @module dsh-search-integrator/pipeline
 */
import { buildDigest, buildEvidence, buildRetrievalContext } from './evidence.js'
import { htmlToExcerpt } from './fetch-page.js'
import type { PageFetcher } from './fetch-page.js'
import { MAX_QUERIES, PROMPT_VERSION, planQueries, runIntegration } from './integrate.js'
import type { RawIntegration } from './integrate.js'
import type { LlmPort, LlmUsage } from './llm.js'
import type { SearchAdapter } from './providers.js'
import type { SearchIntegratorSettings } from './settings.js'
import type {
  AuditRef, Coverage, RawHit, ResearchResult, ResultSource, SourceFailure,
} from './types.js'

/** Everything one execution needs, injected for testability. */
export interface PipelineDeps {
  readonly adapters: readonly SearchAdapter[]
  /** Sources enabled in config but unusable (e.g. missing key). */
  readonly configFailures: readonly SourceFailure[]
  /** Integrator port; absent when no route is configured. */
  readonly llm: LlmPort | undefined
  readonly audit: { save(payload: string, suggestedName: string): Promise<AuditRef | undefined> }
  readonly settings: SearchIntegratorSettings
  /** Best-effort page fetcher for thin top sources (tests inject). */
  readonly fetchPage?: PageFetcher
}

/** Tool arguments after validation. */
export interface ResearchArgs {
  readonly question: string
  readonly queries?: readonly string[]
}

/** Never start a follow-up round with less than this much budget left. */
const FOLLOWUP_MIN_REMAINING_MS = 25_000

/** Cap on follow-up queries per round. */
const MAX_FOLLOWUP_QUERIES = 2

/**
 * Cancellation must propagate, not masquerade as a source failure: the
 * fan-out below settles with allSettled, so an aborted budget would otherwise
 * silently become "no results". Checked between stages.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('research run aborted')
}

interface RoundRecord {
  queries: string[]
  hits: RawHit[]
  failures: SourceFailure[]
}

/** Generation-backed sources are too slow to also fund a follow-up round:
 * a web_search-inside-a-model call can legally take tens of seconds, and the
 * remaining budget after round 1 plus the second integration would not fit
 * another one. Follow-ups close factual gaps; fast SERP entries suffice. */
const GENERATIVE_SOURCES = new Set(['chatgpt', 'openai'])

/** One fan-out round across all adapters and queries. */
async function searchRound(
  adapters: readonly SearchAdapter[],
  queries: readonly string[],
  signal: AbortSignal,
  exclude?: ReadonlySet<string>,
): Promise<{ hits: RawHit[]; failures: SourceFailure[]; succeeded: Set<string> }> {
  const tasks: { adapter: SearchAdapter; query: string }[] = []
  for (const adapter of adapters) {
    if (exclude?.has(adapter.id)) continue
    for (const query of queries) tasks.push({ adapter, query })
  }
  const settled = await Promise.allSettled(
    tasks.map(({ adapter, query }) => adapter.search(query, signal)),
  )
  const hits: RawHit[] = []
  const errorsByAdapter = new Map<string, unknown[]>()
  const succeeded = new Set<string>()
  settled.forEach((outcome, index) => {
    const { adapter } = tasks[index] as { adapter: SearchAdapter; query: string }
    if (outcome.status === 'fulfilled') {
      succeeded.add(adapter.id)
      for (const hit of outcome.value) hits.push(hit)
    } else {
      const list = errorsByAdapter.get(adapter.id) ?? []
      list.push(outcome.reason)
      errorsByAdapter.set(adapter.id, list)
    }
  })
  const failures: SourceFailure[] = [...errorsByAdapter.entries()]
    .filter(([, errors]) => errors.length === queries.length)
    .map(([source, errors]) => ({
      source,
      reason: String(errors[0]).slice(0, 200),
    }))
  return { hits, failures, succeeded }
}

function toResultSources(
  evidence: readonly {
    id: number
    url: string
    title?: string
    snippet: string
    publishedAt?: string
    providers: readonly string[]
  }[],
): ResultSource[] {
  return evidence.map((source) => ({
    id: source.id,
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === '' ? {} : {
      snippet: source.snippet.length > 240 ? `${source.snippet.slice(0, 240)}…` : source.snippet,
    }),
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
    providers: source.providers,
  }))
}

function termsOf(question: string, queries: readonly string[]): string[] {
  return [question, ...queries].join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 }

function addUsage(a: LlmUsage, b: LlmUsage | undefined): LlmUsage {
  return {
    inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
  }
}

/**
 * Run one research task under a shared wall-clock budget.
 *
 * @param deps - adapters, integrator port, audit port, settings snapshot.
 * @param args - validated tool arguments.
 * @param callerSignal - the tool execution's cancellation signal.
 * @returns the canonical result; never throws except on cancellation.
 */
export async function runResearch(
  deps: PipelineDeps,
  args: ResearchArgs,
  callerSignal: AbortSignal,
): Promise<ResearchResult> {
  const started = Date.now()
  const budget = new AbortController()
  const onCallerAbort = (): void => budget.abort()
  callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  // An already-aborted caller never fires the listener above — propagate manually.
  if (callerSignal.aborted) onCallerAbort()
  const timer = setTimeout(() => budget.abort(), deps.settings.totalBudgetMs)
  const signal = budget.signal
  throwIfAborted(signal)

  try {
    const configFailures = deps.configFailures
    if (deps.adapters.length === 0) {
      return failedResult(args.question, [], configFailures,
        `no search sources available: ${failureList(configFailures)}`)
    }

    // 1. Seed queries: caller-provided, else planned, else the raw question.
    const seedQueries = args.queries !== undefined && args.queries.length > 0
      ? args.queries.slice(0, MAX_QUERIES)
      : deps.llm !== undefined
        ? await planQueries(deps.llm, args.question, signal) ?? [args.question]
        : [args.question]
    const queries = [...new Set(seedQueries.map((query) => query.trim()).filter((q) => q !== ''))]
    const effectiveQueries = queries.length > 0 ? queries : [args.question]
    const terms = termsOf(args.question, effectiveQueries)

    // 2. Round 1 retrieval.
    const round1 = await searchRound(deps.adapters, effectiveQueries, signal)
    throwIfAborted(signal)
    const searched = new Set(round1.succeeded)
    const rounds: RoundRecord[] = [{ queries: [...effectiveQueries], hits: round1.hits, failures: round1.failures }]
    let failures = [...configFailures, ...round1.failures]
    if (round1.hits.length === 0) {
      return failedResult(args.question, effectiveQueries, failures,
        `no search results (queries: ${effectiveQueries.join(' | ')}); failed sources: ${failureList(round1.failures) === '' ? 'none' : failureList(round1.failures)}`)
    }

    // 3. Evidence + first integration.
    const evidence1 = await enrichThinSources(
      buildEvidence(round1.hits, terms, deps.settings.maxEvidence),
      deps,
      signal,
    )
    const digest1 = buildRetrievalContext({
      searchedAt: new Date(started).toISOString(),
      queries: [...effectiveQueries],
      searched: [...searched],
      failed: [...configFailures, ...round1.failures],
    }) + '\n\n' + buildDigest(evidence1, deps.settings.excerptChars, 24_000)
    let llmUsage: LlmUsage = EMPTY_USAGE
    const rawOutputs: string[] = []
    let integration: RawIntegration | undefined
    let degradedReason: string | undefined
    if (deps.llm === undefined) {
      degradedReason = 'integrator model not configured (integratorProvider/integratorModel); evidence below is deduplicated and ranked but NOT synthesized or verified'
    } else {
      const outcome = await runIntegration(
        deps.llm, args.question, digest1, evidence1.length, signal,
        { maxTokens: deps.settings.integratorMaxTokens },
      )
      throwIfAborted(signal)
      llmUsage = addUsage(llmUsage, outcome.usage)
      rawOutputs.push(...outcome.rawOutputs)
      if (outcome.kind === 'failed') {
        degradedReason = `integration failed (${outcome.reason}); evidence below is deduplicated and ranked but NOT synthesized or verified`
      } else {
        integration = outcome.integration
      }
    }

    // 4. Optional follow-up round (only when round 1 integrated cleanly).
    let evidence = evidence1
    let digestUsed = digest1
    let coverageRounds = 1
    let coverageQueries = [...effectiveQueries]
    if (integration !== undefined
      && integration.followupNeeded
      && deps.settings.followupRounds > 0
      && deps.llm !== undefined
      && !signal.aborted
      && deps.settings.totalBudgetMs - (Date.now() - started) > FOLLOWUP_MIN_REMAINING_MS) {
      const followupQueries = [...new Set(integration.followupQueries)]
        .slice(0, MAX_FOLLOWUP_QUERIES)
      const round2 = await searchRound(deps.adapters, followupQueries, signal, GENERATIVE_SOURCES)
      throwIfAborted(signal)
      for (const id of round2.succeeded) searched.add(id)
      rounds.push({ queries: followupQueries, hits: round2.hits, failures: round2.failures })
      failures = [...configFailures, ...round1.failures, ...round2.failures]
      const mergedHits = [...round1.hits, ...round2.hits]
      const evidence2 = await enrichThinSources(
        buildEvidence(mergedHits, terms, deps.settings.maxEvidence),
        deps,
        signal,
      )
      const digest2 = buildRetrievalContext({
        searchedAt: new Date(started).toISOString(),
        queries: [...effectiveQueries, ...followupQueries],
        searched: [...searched],
        failed: failures,
      }) + '\n\n' + buildDigest(evidence2, deps.settings.excerptChars, 24_000)
      const outcome2 = await runIntegration(
        deps.llm, args.question, digest2, evidence2.length, signal,
        { maxTokens: deps.settings.integratorMaxTokens, finalRound: true },
      )
      throwIfAborted(signal)
      llmUsage = addUsage(llmUsage, outcome2.usage)
      rawOutputs.push(...outcome2.rawOutputs)
      coverageRounds = 2
      coverageQueries = [...effectiveQueries, ...followupQueries]
      if (outcome2.kind === 'ok') {
        // Adopt the second round only as a whole: its citations match evidence2's
        // numbering, so the evidence and the integration switch together.
        integration = outcome2.integration
        evidence = evidence2
        digestUsed = digest2
      } else {
        integration = {
          ...integration,
          unknowns: [...integration.unknowns,
            `follow-up round failed (${outcome2.reason}); first-pass integration kept`],
        }
      }
    }

    // 5. Compose the result.
    const durationMs = Date.now() - started
    let auditRef: AuditRef | undefined
    if (deps.settings.auditEnabled) {
      const payload = JSON.stringify({
        version: 1,
        promptVersion: PROMPT_VERSION,
        startedAt: new Date(started).toISOString(),
        durationMs,
        question: args.question,
        rounds: rounds.map((round) => ({
          queries: round.queries,
          hitCount: round.hits.length,
          failures: round.failures,
          hits: round.hits,
        })),
        evidence,
        digest: digestUsed,
        llmRawOutputs: rawOutputs,
        usage: llmUsage,
        settings: {
          maxEvidence: deps.settings.maxEvidence,
          perSourceResults: deps.settings.perSourceResults,
          excerptChars: deps.settings.excerptChars,
          followupRounds: deps.settings.followupRounds,
          integratorProvider: deps.settings.integratorProvider,
          integratorModel: deps.settings.integratorModel,
        },
      }, null, 2)
      try {
        auditRef = await deps.audit.save(payload, 'web-research-audit.json')
      } catch {
        // Audit is best-effort by design; the research result stands.
      }
    }

    const coverage: Coverage = {
      rounds: coverageRounds,
      queries: coverageQueries,
      searched: [...searched],
      failed: dedupeFailures(failures),
      resultsFound: rounds.reduce((sum, round) => sum + round.hits.length, 0),
      evidenceCount: evidence.length,
    }
    const base = {
      question: args.question,
      sources: toResultSources(evidence),
      coverage,
      ...(auditRef === undefined ? {} : { audit: auditRef }),
    }
    if (integration === undefined) {
      return {
        ...base,
        status: 'degraded',
        summary: `Integrated synthesis is unavailable: ${degradedReason ?? 'unknown reason'}.`,
        points: [],
        unknowns: ['Every item below is unverified search evidence; treat with caution and verify before relying on it.'],
        degradedReason,
      }
    }
    return {
      ...base,
      status: 'ok',
      summary: integration.summary,
      points: integration.points,
      unknowns: [...integration.unknowns],
    }
  } finally {
    clearTimeout(timer)
    callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

/** Below this many content characters a top source counts as thin. */
const THIN_CONTENT_CHARS = 600

/**
 * Fetch page bodies for the top ranked sources whose provider content is
 * thin, in parallel and best-effort: any failure keeps the provider snippet.
 */
async function enrichThinSources(
  evidence: readonly import('./types.js').EvidenceSource[],
  deps: PipelineDeps,
  signal: AbortSignal,
): Promise<import('./types.js').EvidenceSource[]> {
  const fetcher = deps.fetchPage
  if (fetcher === undefined || deps.settings.fetchTopN <= 0) return [...evidence]
  const targets = new Set(
    evidence.slice(0, deps.settings.fetchTopN)
      .filter((source) => Math.max(source.content?.length ?? 0, source.snippet.length) < THIN_CONTENT_CHARS)
      .map((source) => source.id),
  )
  if (targets.size === 0) return [...evidence]
  const cap = deps.settings.excerptChars
  const settled = await Promise.allSettled(
    evidence.map(async (source) => {
      if (!targets.has(source.id)) return source
      // Each page fetch gets its own deadline: a slow site must not eat the
      // shared budget the sources and the integrator still need.
      const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(deps.settings.perRequestTimeoutMs)])
      try {
        const page = await fetcher(source.url, fetchSignal)
        if (page === undefined) return source
        const excerpt = htmlToExcerpt(page.body, cap)
        const current = Math.max(source.content?.length ?? 0, source.snippet.length)
        if (excerpt.length <= current) return source
        return { ...source, content: excerpt }
      } catch {
        return source
      }
    }),
  )
  return settled.map((entry) => entry.status === 'fulfilled' ? entry.value : (entry.reason as never))
}

function failureList(failures: readonly SourceFailure[]): string {
  return failures.map((failure) => `${failure.source}: ${failure.reason}`).join('; ')
}

function dedupeFailures(failures: readonly SourceFailure[]): SourceFailure[] {
  const seen = new Map<string, SourceFailure>()
  for (const failure of failures) {
    if (!seen.has(failure.source)) seen.set(failure.source, failure)
  }
  return [...seen.values()]
}

function failedResult(
  question: string,
  queries: readonly string[],
  failures: readonly SourceFailure[],
  summary: string,
): ResearchResult {
  return {
    status: 'failed',
    question,
    summary,
    points: [],
    unknowns: [],
    sources: [],
    coverage: {
      rounds: 0,
      queries: [...queries],
      searched: [],
      failed: dedupeFailures(failures),
      resultsFound: 0,
      evidenceCount: 0,
    },
    degradedReason: summary,
  }
}
