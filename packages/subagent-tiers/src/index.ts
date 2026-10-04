/**
 * dsh-subagent-tiers — 三档固定路由委派工具（quick / workhorse / smart）。
 *
 * 背景：`@deepseek-ai/dsh-tool-subagent` 的工具描述是 `providerWording()` 的
 * 固定文案，三个实例一字不差，模型选型时 schema 里没有任何成本/能力信号，
 * 只能靠名字猜——实测（2026-10-03/04 所有 workspace 的 tool/call 事件）主力档
 * 被选 14 次、最贵 smart 档 4 次、便宜 quick 档仅 2 次：系统性 over-escalation。
 *
 * 本插件自己注册三个工具，把档位语义写进各自的 description（工具定义是选型
 * 时最强的信号）；路由仍像 subagents.patch.yml 时代一样在配置层钉死，模型只
 * 能"选工具"，不能选模型。行为对齐 stock 的 continuable 配置：后台默认
 * （`run_in_background: false` 才前台等待），depth 读宿主 `subagent.maxDepth`
 * 设置，创建子代理前经 `ctx.llm.resolveCallConfig` 预检路由。
 *
 * 不替代 `subagent_fork`（fork 继承父上下文与父模型是刻意的，见
 * subagents.patch.yml 注释）。挂载本插件的 profile 必须 disable stock 的
 * `tool-subagent` 行，否则 preset 实例与本插件的 `subagent` 工具重名。
 *
 * @module dsh-subagent-tiers
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'subagent-tiers'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

/** One fixed delegation tier: a model-facing tool name plus its pinned LLM route. */
export interface TierRoute {
  /** Model-facing tool name; must be distinct across tiers. */
  toolName: string
  /** Registered LLM provider route for every child of this tier. */
  provider: string
  /** Provider-owned exact model id. */
  model: string
  /** Adapter-owned reasoning effort; omit for the model's default. */
  reasoningEffort?: string
}

/** Config: the subagents backend plus the three pinned tier routes. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`). */
  provider: string
  /** Cheap & fast tier — the default delegation target. */
  quick: TierRoute
  /** Capable general-purpose tier. */
  workhorse: TierRoute
  /** Strongest, most expensive tier — reserved for genuinely hard work. */
  smart: TierRoute
}

/** One tier's defaults as a fresh Schema.object (schemastery schemas are not safely shareable across fields). */
const tierRoute = (defaults: TierRoute) => Schema.object({
  toolName: Schema.string().default(defaults.toolName),
  provider: Schema.string().default(defaults.provider),
  model: Schema.string().default(defaults.model),
  reasoningEffort: Schema.string().default(defaults.reasoningEffort ?? 'max'),
}).default(defaults)

export const Config = Schema.object({
  provider: Schema.string().default('spawn'),
  quick: tierRoute({ toolName: 'subagent_quick', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }),
  workhorse: tierRoute({ toolName: 'subagent', provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }),
  smart: tierRoute({ toolName: 'subagent_smart', provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }),
})

/**
 * Tier-specific tool descriptions — the whole point of this plugin. Each states
 * its own selection rule; the escalation ladder reads bottom-up and is
 * failure-driven (models judge "the previous result was insufficient" far more
 * reliably than "the upcoming task is simple").
 */
const TIER_DESCRIPTIONS = {
  quick: 'Delegate a self-contained task to a fast, economical subagent (a separate agent that works in its own context). This is the default tier for delegation: mechanical subtasks, retrieval, counting, formatting, batch checks over many items — any focused work whose result you can verify directly. Escalate to a stronger tier only when this tier\'s result proves insufficient. The subagent returns its result, not its intermediate steps. It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when the run settles.',
  workhorse: 'Delegate a self-contained task to a capable general-purpose subagent (a separate agent that works in its own context). Use this tier when the work needs real engineering depth — multi-file implementation, careful analysis, design work — that subagent_quick cannot handle; prefer subagent_quick for mechanical work. The subagent returns its result, not its intermediate steps. It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when the run settles.',
  smart: 'Delegate a self-contained task to the strongest and most expensive subagent (a separate agent that works in its own context). Reserve this tier for genuinely hard reasoning — architecture decisions, adversarial review, subtle cross-cutting bugs — or when subagent and subagent_quick both returned inadequate results. Never use it for work a cheaper tier can do. The subagent returns its result, not its intermediate steps. It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when the run settles.',
} as const

const PROMPT_PARAMETER_DESCRIPTION = 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.'

/** Shared output contract: a continuable child id, or the collected foreground output. `as const` keeps the discriminant literals for InferValue. */
const delegationOutputSchema = { oneOf: [
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', required: true, const: 'continuable' },
      subagentId: { type: 'string', required: true },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', required: true, const: 'foreground' },
      runId: { type: 'string', required: true },
      output: { type: 'array', required: true, items: { type: 'json' } },
    },
  },
] } as const

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: readonly unknown[]): string {
  return values.filter((value): value is { text: string } => typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { type?: unknown }).type === 'text' && typeof (value as { text?: unknown }).text === 'string').map((value) => value.text).join('')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append provider-authored failure detail and the child's preserved partial answer to a stop-reason error. */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output.filter((block) => block.type === 'text').map((block) => block.text).join('')
  return `${error}${diagnostic}${text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`}`
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(run: SubagentRun) {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result)
    if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
    return {
      kind: 'foreground' as const,
      runId: run.id as string,
      // ContentBlocks travel the session log as lossless JSON; the output
      // schema types them as the broader JsonValue[].
      output: [...result.output] as unknown as JsonValue[],
    }
  })])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`)
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** Install the three-tier delegation composition. */
export function apply(ctx: Context, config: Config) {
  const tiers = [
    { route: config.quick, description: TIER_DESCRIPTIONS.quick },
    { route: config.workhorse, description: TIER_DESCRIPTIONS.workhorse },
    { route: config.smart, description: TIER_DESCRIPTIONS.smart },
  ]
  const toolNames = new Set(tiers.map((tier) => tier.route.toolName))
  if (toolNames.size !== tiers.length) throw new Error('subagent-tiers: tier toolNames must be distinct')

  const assertProviderConfiguration = (subagentProvider: SubagentProvider) => {
    if (!subagentProvider.capabilities.agentOptions) throw new Error(`subagent-tiers: provider "${subagentProvider.name}" does not support child agentOptions`)
    if (subagentProvider.prepareContinuable === undefined) throw new Error(`subagent-tiers: provider "${subagentProvider.name}" does not support continuable children`)
  }

  let mounted: (() => void)[] | undefined
  const mount = (subagentProvider: SubagentProvider) => {
    assertProviderConfiguration(subagentProvider)
    mounted = tiers.map(({ route: tier, description }) => ctx.tools.register(defineTool({
      name: tier.toolName,
      description,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: PROMPT_PARAMETER_DESCRIPTION,
        },
        run_in_background: {
          type: 'boolean',
          description: 'Defaults to true. Set false only when your next action depends on the result.',
        },
      },
      output: {
        schema: delegationOutputSchema,
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'continuable' ? `started subagent ${value.subagentId}` : outputValueText(value.output),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error(`${tier.toolName} requires a calling agent (exec.agent was undefined)`)
        exec.signal.throwIfAborted()
        const agentOptions = {
          provider: tier.provider,
          model: tier.model,
          ...(tier.reasoningEffort !== undefined && tier.reasoningEffort !== '' ? { reasoningEffort: ReasoningEffortId(tier.reasoningEffort) } : {}),
        }
        await ctx.llm.resolveCallConfig(agentOptions, exec.signal)
        if (ctx.subagents.getProvider(config.provider) !== subagentProvider) throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
        const maxDepth = ctx.subagents.resolveMaxDepth()
        const request = {
          prompt: [{ type: 'text' as const, text: args.prompt }],
          parent,
          agentOptions,
          ...(maxDepth !== undefined ? { maxDepth } : {}),
        }
        if (args.run_in_background !== false) {
          const start = await ctx.subagents.startContinuable({
            provider: config.provider,
            label: args.description,
            request,
            signal: exec.signal,
          })
          return { kind: 'continuable' as const, subagentId: start.childId as string }
        }
        return settleForegroundRun(await ctx.subagents.start(config.provider, {
          ...request,
          label: args.description,
          signal: exec.signal,
        }))
      },
    })))
  }
  const unmount = () => {
    if (mounted === undefined) return
    for (const dispose of mounted) dispose()
    mounted = undefined
  }

  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== config.provider || mounted === undefined) return
    unmount()
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) mount(present)
  else ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the subagent-tiers tools will register when it appears`)

  ctx.systemPrompt.section({
    name: 'tool:subagent-tiers',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => mounted === undefined || tiers.some((tier) => ctx.tools.get(tier.route.toolName, context.scope) === undefined)
      ? ''
      : 'Start independent subagent delegations together in one assistant message and continue useful work while they run.',
  })
}
