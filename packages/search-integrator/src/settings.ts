/**
 * Row configuration (dsh 0.2 settings model), resolved into a plain snapshot
 * the pipeline reads once per call.
 *
 * Registration-time facts (`enabled`, `toolName`, `timeoutMs`) are NOT
 * volatile: editing them remounts the row, which is the desired effect — the
 * master switch should actually remove the tool, and the timeout is declared
 * as `ToolDefinition.timeoutMs` at registration. Everything the pipeline can
 * honor mid-flight (provider toggles, credential references, integrator
 * route, budgets) is volatile and read live at each execution.
 *
 * Secrets never appear here: each provider has only the *reference* — an
 * environment-variable name resolved through `ctx.credentials` per call.
 *
 * @module dsh-search-integrator/settings
 */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Snapshot of the live settings the pipeline consumes. */
export interface SearchIntegratorSettings {
  readonly zhipuEnabled: boolean
  readonly zhipuApiKeyRef: string
  /** `mcp` = Coding-Plan MCP broker (per-plan quota); `rest` = open-platform per-call API. */
  readonly zhipuTransport: 'mcp' | 'rest'
  readonly zhipuMcpUrl: string
  readonly zhipuMcpTool: string
  readonly zhipuApiBase: string
  readonly zhipuEngine: string
  readonly tavilyEnabled: boolean
  readonly tavilyApiKeyRef: string
  readonly tavilyApiBase: string
  readonly tavilySearchDepth: string
  readonly tavilyIncludeRaw: boolean
  readonly braveEnabled: boolean
  readonly braveApiKeyRef: string
  readonly braveApiBase: string
  readonly openaiEnabled: boolean
  readonly openaiApiKeyRef: string
  readonly openaiApiBase: string
  readonly openaiModel: string
  readonly openaiSearchContextSize: string
  readonly openaiReasoningEffort: string
  /** ChatGPT subscription source: Codex backend over the oauth-providers service. */
  readonly chatgptEnabled: boolean
  readonly chatgptModel: string
  readonly chatgptApiBase: string
  readonly exaEnabled: boolean
  readonly exaApiKeyRef: string
  readonly exaApiBase: string
  readonly integratorProvider: string
  readonly integratorModel: string
  readonly integratorMaxTokens: number
  readonly followupRounds: number
  readonly maxEvidence: number
  /** Top ranked sources whose thin provider content gets a page-body fetch. */
  readonly fetchTopN: number
  readonly perSourceResults: number
  readonly excerptChars: number
  readonly totalBudgetMs: number
  readonly perRequestTimeoutMs: number
  readonly maxRenderChars: number
  readonly auditEnabled: boolean
}

/** Plugin-row configuration; the Settings form edits the volatile fields live. */
export interface Config {
  readonly enabled: boolean
  readonly toolName: string
  readonly timeoutMs: number
  readonly zhipuEnabled: Volatile<boolean>
  readonly zhipuApiKeyRef: Volatile<string>
  readonly zhipuTransport: Volatile<'mcp' | 'rest'>
  readonly zhipuMcpUrl: Volatile<string>
  readonly zhipuMcpTool: Volatile<string>
  readonly zhipuApiBase: Volatile<string>
  readonly zhipuEngine: Volatile<string>
  readonly tavilyEnabled: Volatile<boolean>
  readonly tavilyApiKeyRef: Volatile<string>
  readonly tavilyApiBase: Volatile<string>
  readonly tavilySearchDepth: Volatile<string>
  readonly tavilyIncludeRaw: Volatile<boolean>
  readonly braveEnabled: Volatile<boolean>
  readonly braveApiKeyRef: Volatile<string>
  readonly braveApiBase: Volatile<string>
  readonly openaiEnabled: Volatile<boolean>
  readonly openaiApiKeyRef: Volatile<string>
  readonly openaiApiBase: Volatile<string>
  readonly openaiModel: Volatile<string>
  readonly openaiSearchContextSize: Volatile<string>
  readonly openaiReasoningEffort: Volatile<string>
  readonly chatgptEnabled: Volatile<boolean>
  readonly chatgptModel: Volatile<string>
  readonly chatgptApiBase: Volatile<string>
  readonly exaEnabled: Volatile<boolean>
  readonly exaApiKeyRef: Volatile<string>
  readonly exaApiBase: Volatile<string>
  readonly integratorProvider: Volatile<string>
  readonly integratorModel: Volatile<string>
  readonly integratorMaxTokens: Volatile<number>
  readonly followupRounds: Volatile<number>
  readonly maxEvidence: Volatile<number>
  readonly fetchTopN: Volatile<number>
  readonly perSourceResults: Volatile<number>
  readonly excerptChars: Volatile<number>
  readonly totalBudgetMs: Volatile<number>
  readonly perRequestTimeoutMs: Volatile<number>
  readonly maxRenderChars: Volatile<number>
  readonly auditEnabled: Volatile<boolean>
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 types volatile modes
// into the schema generics, and an annotation would fight the inference the
// loader validates `Config` against (same discipline as auto-permit).
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description(
    'Master switch. Off unregisters the web_research tool (edit remounts the row).',
  ),
  toolName: Schema.string().default('web_research').description(
    'Tool name registered for the main model (edit remounts the row).',
  ),
  timeoutMs: Schema.number().default(140000).description(
    'Cooperative tool-call timeout budget in ms (registration-time).',
  ),
  zhipuEnabled: Schema.boolean().default(true).volatile().description(
    'Enable the Zhipu (bigmodel.cn) standalone web-search source.',
  ),
  zhipuApiKeyRef: Schema.string().default('ZHIPU_API_KEY').volatile().description(
    'Credential reference (env-var name) holding the Zhipu API key. With transport mcp this is the Coding-Plan key.',
  ),
  zhipuTransport: Schema.union(['mcp', 'rest']).default('mcp').volatile().description(
    'mcp: the official MCP broker (covered by GLM Coding-Plan MCP quota). rest: the open-platform per-call web_search API.',
  ),
  zhipuMcpUrl: Schema.string().default('https://open.bigmodel.cn/api/mcp/web_search_prime/mcp').volatile().description(
    'Zhipu web-search MCP endpoint (streamable HTTP). The default is the GLM Coding-Plan dedicated server.',
  ),
  zhipuMcpTool: Schema.string().default('webSearchPrime').volatile().description(
    'MCP tool name on that endpoint; discovered via tools/list when wrong.',
  ),
  zhipuApiBase: Schema.string().default('https://open.bigmodel.cn/api/paas/v4').volatile().description(
    'Zhipu REST API base URL (transport rest only).',
  ),
  zhipuEngine: Schema.string().default('search_std').volatile().description(
    'Zhipu search engine: search_std, search_pro, search_pro_sogou, or search_pro_quark.',
  ),
  tavilyEnabled: Schema.boolean().default(true).volatile().description(
    'Enable the Tavily search source.',
  ),
  tavilyApiKeyRef: Schema.string().default('TAVILY_API_KEY').volatile().description(
    'Credential reference (env-var name) holding the Tavily API key.',
  ),
  tavilyApiBase: Schema.string().default('https://api.tavily.com').volatile().description(
    'Tavily API base URL.',
  ),
  tavilySearchDepth: Schema.string().default('basic').volatile().description(
    'Tavily search depth: basic, advanced, fast, or ultra-fast.',
  ),
  tavilyIncludeRaw: Schema.boolean().default(false).volatile().description(
    'Request cleaned raw page content from Tavily (larger, costlier responses).',
  ),
  braveEnabled: Schema.boolean().default(false).volatile().description(
    'Enable the Brave Search API source (independent index; ~$5/1k requests).',
  ),
  braveApiKeyRef: Schema.string().default('BRAVE_API_KEY').volatile().description(
    'Credential reference (env-var name) holding the Brave API key (X-Subscription-Token).',
  ),
  braveApiBase: Schema.string().default('https://api.search.brave.com/res/v1').volatile().description(
    'Brave Search API base URL.',
  ),
  openaiEnabled: Schema.boolean().default(false).volatile().description(
    'Enable the OpenAI web-search source (Responses API web_search tool; $10/1k search calls + model tokens — the priciest source).',
  ),
  openaiApiKeyRef: Schema.string().default('OPENAI_API_KEY').volatile().description(
    'Credential reference (env-var name) holding the OpenAI API key.',
  ),
  openaiApiBase: Schema.string().default('https://api.openai.com/v1').volatile().description(
    'OpenAI API base URL.',
  ),
  openaiModel: Schema.string().default('gpt-5.5').volatile().description(
    'Model used for the Responses web_search call.',
  ),
  openaiSearchContextSize: Schema.union(['low', 'medium', 'high']).default('low').volatile().description(
    'Search context size; low keeps tokens minimal (the integrator only needs cited URLs).',
  ),
  openaiReasoningEffort: Schema.string().default('low').volatile().description(
    'Reasoning effort for the OpenAI call; set empty to omit (for non-reasoning models).',
  ),
  chatgptEnabled: Schema.boolean().default(false).volatile().description(
    'Enable the ChatGPT-subscription web-search source: the Codex backend (Responses API) over the oauth-providers sign-in. Consumes subscription quota; off by default.',
  ),
  chatgptModel: Schema.string().default('gpt-5.5').volatile().description(
    'Codex backend model for the ChatGPT source (must be one the backend reports).',
  ),
  chatgptApiBase: Schema.string().default('https://chatgpt.com/backend-api/codex').volatile().description(
    'Codex backend base URL for the ChatGPT source.',
  ),
  exaEnabled: Schema.boolean().default(true).volatile().description(
    'Enable the Exa search source.',
  ),
  exaApiKeyRef: Schema.string().default('EXA_API_KEY').volatile().description(
    'Credential reference (env-var name) holding the Exa API key.',
  ),
  exaApiBase: Schema.string().default('https://api.exa.ai').volatile().description(
    'Exa API base URL.',
  ),
  integratorProvider: Schema.string().default('deepseek-official').volatile().description(
    'Integrator model provider (llm route id). Empty disables synthesis (degraded results).',
  ),
  integratorModel: Schema.string().default('deepseek-flash').volatile().description(
    'Integrator model id on that provider. A small/fast model is usually right.',
  ),
  integratorMaxTokens: Schema.number().default(8192).volatile().description(
    'Max output tokens for one integrator call. Reasoning models burn this budget on thinking first.',
  ),
  followupRounds: Schema.number().default(1).volatile().description(
    'Max follow-up search rounds after the integrator flags a gap (0 disables).',
  ),
  maxEvidence: Schema.number().default(14).volatile().description(
    'Evidence entries kept after dedup and ranking.',
  ),
  fetchTopN: Schema.number().default(2).volatile().description(
    'Top-ranked sources with thin content (e.g. snippet-less URLs) get one best-effort page fetch for a body excerpt. 0 disables.',
  ),
  perSourceResults: Schema.number().default(8).volatile().description(
    'Results requested per provider per query.',
  ),
  excerptChars: Schema.number().default(1600).volatile().description(
    'Per-source excerpt character cap in the integrator digest.',
  ),
  totalBudgetMs: Schema.number().default(125000).volatile().description(
    'Wall-clock budget shared by every call of one research run (ms). Sized for one slow generative source round + integration + a fast follow-up round.',
  ),
  perRequestTimeoutMs: Schema.number().default(12000).volatile().description(
    'Per-request timeout applied to every provider HTTP call, independent of the shared budget.',
  ),
  maxRenderChars: Schema.number().default(7000).volatile().description(
    'Character budget for the model-facing render (downstream pruners cap ~8k).',
  ),
  auditEnabled: Schema.boolean().default(true).volatile().description(
    'Persist the full audit artifact (queries, hits, digest, model I/O) to the spill store.',
  ),
})

/**
 * Read the live settings snapshot.
 *
 * @param config - composition row config (volatile live references).
 * @returns the plain snapshot for one execution.
 */
export function readSettings(config: Config): SearchIntegratorSettings {
  return {
    zhipuEnabled: config.zhipuEnabled.get(),
    zhipuApiKeyRef: config.zhipuApiKeyRef.get(),
    zhipuTransport: config.zhipuTransport.get(),
    zhipuMcpUrl: config.zhipuMcpUrl.get(),
    zhipuMcpTool: config.zhipuMcpTool.get(),
    zhipuApiBase: config.zhipuApiBase.get(),
    zhipuEngine: config.zhipuEngine.get(),
    tavilyEnabled: config.tavilyEnabled.get(),
    tavilyApiKeyRef: config.tavilyApiKeyRef.get(),
    tavilyApiBase: config.tavilyApiBase.get(),
    tavilySearchDepth: config.tavilySearchDepth.get(),
    tavilyIncludeRaw: config.tavilyIncludeRaw.get(),
    braveEnabled: config.braveEnabled.get(),
    braveApiKeyRef: config.braveApiKeyRef.get(),
    braveApiBase: config.braveApiBase.get(),
    openaiEnabled: config.openaiEnabled.get(),
    openaiApiKeyRef: config.openaiApiKeyRef.get(),
    openaiApiBase: config.openaiApiBase.get(),
    openaiModel: config.openaiModel.get(),
    openaiSearchContextSize: config.openaiSearchContextSize.get(),
    openaiReasoningEffort: config.openaiReasoningEffort.get(),
    chatgptEnabled: config.chatgptEnabled.get(),
    chatgptModel: config.chatgptModel.get(),
    chatgptApiBase: config.chatgptApiBase.get(),
    exaEnabled: config.exaEnabled.get(),
    exaApiKeyRef: config.exaApiKeyRef.get(),
    exaApiBase: config.exaApiBase.get(),
    integratorProvider: config.integratorProvider.get(),
    integratorModel: config.integratorModel.get(),
    integratorMaxTokens: config.integratorMaxTokens.get(),
    followupRounds: config.followupRounds.get(),
    maxEvidence: config.maxEvidence.get(),
    fetchTopN: config.fetchTopN.get(),
    perSourceResults: config.perSourceResults.get(),
    excerptChars: config.excerptChars.get(),
    totalBudgetMs: config.totalBudgetMs.get(),
    perRequestTimeoutMs: config.perRequestTimeoutMs.get(),
    maxRenderChars: config.maxRenderChars.get(),
    auditEnabled: config.auditEnabled.get(),
  }
}

/** True when the integrator route is configured (not necessarily reachable). */
export function integratorConfigured(settings: SearchIntegratorSettings): boolean {
  return settings.integratorProvider !== '' && settings.integratorModel !== ''
}
