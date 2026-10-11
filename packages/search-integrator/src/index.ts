/**
 * dsh-search-integrator — a multi-source web research tool.
 *
 * The plugin registers ONE host-side tool (`web_research` by default). It
 * takes a whole question, fans it out to the configured search providers
 * (Zhipu / Tavily / Exa, keys via `ctx.credentials` references), merges and
 * ranks the evidence deterministically, and has a configured integrator model
 * return a citation-checked synthesis with explicit unknowns and coverage
 * notes. The main model never filters raw hit lists; the full audit trail
 * lives in a spill artifact pointed to by the result.
 *
 * Consumed host services (injected): `tools`, `llm`, `credentials`,
 * `systemPrompt`. `spillStore` is used opportunistically when a backend is
 * mounted.
 *
 * @module dsh-search-integrator
 */
import type { Context } from '@deepseek-ai/cordis'
import { makeResearchTool, createToolHost } from './tool.js'
import { Config } from './settings.js'
import type { Config as RowConfig } from './settings.js'

export { Config } from './settings.js'
export type { SearchIntegratorSettings } from './settings.js'
export { readSettings, integratorConfigured } from './settings.js'
export { makeResearchTool, createToolHost } from './tool.js'
export { runResearch } from './pipeline.js'
export { buildEvidence, buildDigest, urlDedupKey } from './evidence.js'
export { parseIntegration, extractJsonObject, planQueries, runIntegration, MAX_QUERIES, PROMPT_VERSION } from './integrate.js'
export { createLlmPort } from './llm.js'
export type { LlmPort, LlmCall, LlmCallOutcome, LlmUsage } from './llm.js'
export { buildAdapters, createFakeAdapter } from './providers.js'
export type { AdapterIo, SearchAdapter } from './providers.js'
export { mcpCallTool, fetchRawPost, McpTransportError, McpRpcFailure } from './mcp.js'
export { postJson, getJson, HttpError } from './http.js'
export type { RawPost, McpToolResult } from './mcp.js'
export { renderResearch, researchMeta } from './render.js'
export { createAuditPort, createNullAuditPort } from './audit.js'
export { htmlToExcerpt, fetchPage } from './fetch-page.js'
export type { PageFetcher } from './fetch-page.js'
export type { ResearchResult, EvidenceSource, RawHit } from './types.js'

export const inject = ['tools', 'llm', 'credentials', 'systemPrompt']

/** Prompt-section guidance, blanked when the tool is not visible in scope. */
const SECTION_TEXT = [
  'web_research runs a bounded multi-source research pipeline and returns one integrated,',
  'citation-checked answer with explicit unknowns and coverage notes; raw hits stay in an audit artifact.',
  'Prefer it over web_search when a question needs synthesis or cross-checking between sources.',
  'Do not re-run it merely to "get more results": when its answer marks information missing, refine',
  'the question instead. Cite the included source URLs as markdown links.',
].join(' ')

/**
 * Plugin entry.
 *
 * @param ctx - plugin context.
 * @param config - composition row config (volatile live references).
 */
export function apply(ctx: Context, config: RowConfig): void {
  // `enabled` is registration-time (non-volatile): turning it off in Settings
  // remounts the row and this early return unregisters the tool entirely.
  if (!config.enabled) return
  const host = createToolHost(ctx, config)
  const toolName = config.toolName

  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    // Placed right after the stock web tools block (TOOL_WEB_SEARCH 2000 /
    // TOOL_WEB_FETCH 2100); a raw number is fine for a plugin-owned position.
    order: 2150,
    text: ({ scope }) => ctx.tools.get(toolName, scope) === undefined ? '' : SECTION_TEXT,
  })
  ctx.tools.register(makeResearchTool(host, { name: toolName, timeoutMs: config.timeoutMs }))
}
