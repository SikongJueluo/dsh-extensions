/**
 * The model-facing tool: schema, argument validation, and the execution that
 * wires one pipeline run (credentials → adapters, llm port, audit port).
 *
 * The description promises exactly what the pipeline delivers — one
 * integrated, citation-checked answer — and not a hit list, so the main model
 * has no reason to expect raw candidates it must filter itself.
 *
 * @module dsh-search-integrator/tool
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createAuditPort } from './audit.js'
import { getJson, postJson } from './http.js'
import { fetchRawPost } from './mcp.js'
import type { RawPost } from './mcp.js'
import { MAX_QUERIES } from './integrate.js'
import { createLlmPort } from './llm.js'
import { runResearch } from './pipeline.js'
import { buildAdapters } from './providers.js'
import { renderResearch, researchMeta } from './render.js'
import { integratorConfigured } from './settings.js'
import type { Config, SearchIntegratorSettings } from './settings.js'
import { readSettings } from './settings.js'
import type { ResearchResult } from './types.js'

const TOOL_DESCRIPTION = [
  'Research a question across multiple web search sources and return one integrated answer:',
  'key facts with evidence status (supported / conflicting / insufficient), explicit unknowns,',
  'cited sources, and coverage notes (failed sources, follow-up rounds). Raw hits are deduplicated',
  'and kept out of context in an audit artifact. Use for questions needing current information,',
  'cross-checking between sources, or synthesis; prefer it over plain search when evidence quality matters.',
].join(' ')

/** Per-execution wiring over the host context. */
export interface ToolHost {
  /** Live settings snapshot reader. */
  readonly readSettings: () => SearchIntegratorSettings
  /** Resolve one credential reference; never logged. */
  readonly resolveCredential: (ref: string) => Promise<string | undefined>
  /** Build the llm port for one execution. */
  readonly llmFor: (settings: SearchIntegratorSettings) => ToolHostLlm | undefined
  /** Build the audit port for one execution. */
  readonly auditFor: (callId: ToolCallId, sessionId?: string) => ReturnType<typeof createAuditPort>
  /** Injectable JSON POST for the provider adapters (tests). */
  readonly postJson: typeof postJson
  /** Injectable JSON GET for the provider adapters (tests). */
  readonly getJson: typeof getJson
  /** Injectable raw POST for the MCP broker transport (tests). */
  readonly rawPost: RawPost
  /** Fresh ChatGPT OAuth token via the oauth-providers service (subscription source). */
  readonly chatgptToken: () => Promise<{ access: string; accountId?: string } | undefined>
  /** Log a contained failure at warn level. */
  readonly warn: (message: string, error: unknown) => void
}

export interface ToolHostLlm {
  call(req: { system: string; user: string; maxTokens: number }, signal: AbortSignal): Promise<{
    ok: boolean
    text: string
    finishKind: string
    usage?: { inputTokens: number; outputTokens: number }
    error?: string
  }>
}

/** The host-bound wiring used by the real plugin entry. */
export function createToolHost(ctx: Context, config: Config): ToolHost {
  return {
    readSettings: () => readSettings(config),
    resolveCredential: async (ref) => {
      if (ref === '') return undefined
      const resolved = await ctx.credentials.resolve(credentialRef(ref))
      return resolved?.value
    },
    llmFor: (settings) => (integratorConfigured(settings)
      ? createLlmPort(ctx, {
        provider: settings.integratorProvider,
        model: settings.integratorModel,
        maxTokens: settings.integratorMaxTokens,
      })
      : undefined),
    auditFor: (callId, sessionId) => createAuditPort(ctx, {
      toolName: config.toolName,
      callId,
      ...(sessionId === undefined ? {} : { sessionId: sessionId as never }),
    }),
    postJson,
    getJson,
    rawPost: fetchRawPost(),
    chatgptToken: async () => {
      // Opportunistic: the oauthProviders service exists only while the
      // oauth-providers plugin is mounted and signed in.
      const service = ctx.get('oauthProviders') as
        | { token?: (provider: string) => Promise<{ access: string; accountId?: string } | undefined> }
        | undefined
      return service?.token?.('chatgpt')
    },
    warn: (message, error) => {
      ctx.logger.warn(message, error)
    },
  }
}

interface ParsedArgs {
  readonly question: string
  readonly queries?: readonly string[]
}

/** Defensive argument validation (defineTool already enforces the schema). */
function parseArgs(args: unknown): ParsedArgs {
  const record = args as { question?: unknown; queries?: unknown }
  const question = typeof record.question === 'string' ? record.question.trim() : ''
  if (question === '') throw new Error('question must be a non-empty string')
  if (record.queries === undefined) return { question }
  if (!Array.isArray(record.queries)) throw new Error('queries must be an array of strings')
  const queries = [...new Set(
    record.queries
      .filter((query): query is string => typeof query === 'string')
      .map((query) => query.trim())
      .filter((query) => query !== ''),
  )].slice(0, MAX_QUERIES)
  return queries.length === 0 ? { question } : { question, queries }
}

/** Session id for audit ownership and llm routing metadata, when known. */
function sessionIdOf(exec: ToolRunContext): string | undefined {
  const agent = exec.agent as { id?: string } | undefined
  return typeof agent?.id === 'string' ? agent.id : undefined
}

/**
 * Build the tool definition.
 *
 * @param host - per-execution wiring.
 * @param options - registration-time facts (name, timeout).
 */
export function makeResearchTool(
  host: ToolHost,
  options: { name: string; timeoutMs: number },
): ReturnType<typeof defineTool> {
  return defineTool({
    name: options.name,
    description: TOOL_DESCRIPTION,
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'The complete question or information need, phrased the way you want it answered.',
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional 1-${MAX_QUERIES} seed search queries. Omit to let the pipeline derive them from the question.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded', 'failed'], required: true },
          question: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          points: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                status: { type: 'string', enum: ['supported', 'conflict', 'insufficient'], required: true },
                sources: { type: 'array', required: true, items: { type: 'integer' } },
                sides: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      text: { type: 'string', required: true },
                      sources: { type: 'array', required: true, items: { type: 'integer' } },
                    },
                  },
                },
                quote: { type: 'string' },
                citationFailed: { type: 'boolean' },
              },
            },
          },
          unknowns: { type: 'array', required: true, items: { type: 'string' } },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
                providers: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          coverage: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              rounds: { type: 'integer', required: true },
              queries: { type: 'array', required: true, items: { type: 'string' } },
              searched: { type: 'array', required: true, items: { type: 'string' } },
              failed: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    source: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                  },
                },
              },
              resultsFound: { type: 'integer', required: true },
              evidenceCount: { type: 'integer', required: true },
            },
          },
          audit: {
            type: 'object',
            additionalProperties: false,
            properties: {
              locator: { type: 'string', required: true },
              retrievalHint: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
            },
          },
          degradedReason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderResearch(value as unknown as ResearchResult, host.readSettings().maxRenderChars),
      }],
      presentationMeta: (_args, value) => researchMeta(value as unknown as ResearchResult),
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const settings = host.readSettings()
      const parsed = parseArgs(args)
      const sessionId = sessionIdOf(exec)

      const keys: Partial<Record<'zhipu' | 'tavily' | 'exa' | 'brave' | 'openai', string>> = {}
      const wanted: [('zhipu' | 'tavily' | 'exa' | 'brave' | 'openai'), string][] = []
      if (settings.zhipuEnabled) wanted.push(['zhipu', settings.zhipuApiKeyRef])
      if (settings.tavilyEnabled) wanted.push(['tavily', settings.tavilyApiKeyRef])
      if (settings.exaEnabled) wanted.push(['exa', settings.exaApiKeyRef])
      if (settings.braveEnabled) wanted.push(['brave', settings.braveApiKeyRef])
      if (settings.openaiEnabled) wanted.push(['openai', settings.openaiApiKeyRef])
      const resolvedKeys = await Promise.allSettled(
        wanted.map(async ([, ref]) => host.resolveCredential(ref)),
      )
      resolvedKeys.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled' && outcome.value !== undefined && outcome.value !== '') {
          keys[wanted[index]?.[0] as 'zhipu' | 'tavily' | 'exa' | 'brave' | 'openai'] = outcome.value
        }
      })

      const { adapters, failures } = buildAdapters(settings, keys, {
        postJson: host.postJson,
        getJson: host.getJson,
        rawPost: host.rawPost,
        chatgptToken: host.chatgptToken,
      })
      try {
        return await runResearch(
          {
            adapters,
            configFailures: failures,
            llm: host.llmFor(settings),
            audit: host.auditFor(exec.callId, sessionId),
            settings,
          },
          parsed,
          exec.signal,
        ) as never
      } catch (error) {
        if (exec.signal.aborted) throw error
        host.warn('search-integrator: research run crashed:', error)
        // A crash outside the pipeline's own semantics still returns an
        // explicit failure value rather than an opaque tool error.
        return {
          status: 'failed',
          question: parsed.question,
          summary: `research run crashed: ${String(error)}`,
          points: [],
          unknowns: [],
          sources: [],
          coverage: {
            rounds: 0,
            queries: parsed.queries ?? [],
            searched: adapters.map((adapter) => adapter.id),
            failed: failures,
            resultsFound: 0,
            evidenceCount: 0,
          },
          degradedReason: String(error),
        } as never
      }
    },
  })
}
