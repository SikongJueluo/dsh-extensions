/**
 * dsh-crew — 固定路由的委派工具组（quick / workhorse / smart 三档 +
 * create_agent 常驻角色代理）。
 *
 * 背景：`@deepseek-ai/dsh-tool-subagent` 的工具描述是 `providerWording()` 的
 * 固定文案，多个实例一字不差，模型选型时 schema 里没有任何成本/能力信号，
 * 只能靠名字猜——实测（2026-10-03/04 所有 workspace 的 tool/call 事件）主力档
 * 被选 14 次、最贵 smart 档 4 次、便宜 quick 档仅 2 次：系统性 over-escalation。
 *
 * 本插件自己注册工具，把档位语义写进各自的 description（工具定义是选型时
 * 最强的信号）；路由在配置层钉死，模型只能"选档位"，不能选模型。行为对齐
 * stock 的 continuable 配置：后台默认（`run_in_background: false` 才前台等待），
 * depth 读宿主 `subagent.maxDepth` 设置，创建子代理前经
 * `ctx.llm.resolveCallConfig` 预检路由。
 *
 * create_agent 起一个常驻角色代理：bootstrap 提示词让子代理确认角色后待命，
 * 后续任务经 send_message 投递（配套控制面 tool-subagent-control /
 * tool-subagent-list-agents 提供 send_message / interrupt_agent / list_agents）。
 *
 * 挂载本插件的 profile 应 disable stock 委派工具行（tool-subagent /
 * tool-subagent-fork / tool-workflow / workflow-ptc）：既防 `subagent` 工具
 * 重名，也堵住 fork（继承父模型）与 workflow（脚本自由选路）两条旁路。
 *
 * @module dsh-crew
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'crew'
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

const CREATE_AGENT_DESCRIPTION = 'Create a persistent named agent with a standing role and get its id. The agent confirms its role, then idles until you send it tasks with `send_message`; reuse it for repeated work of the same kind instead of re-stating context on every delegation. `tier` selects the pinned route: quick (default — cheap and fast), workhorse (engineering depth), smart (strongest and most expensive; reserve it). `list_agents` shows your live agents; `interrupt_agent` stops one.'

const PROMPT_PARAMETER_DESCRIPTION = 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.'

/** Shared output contract of the delegation tools: a continuable child id, or the collected foreground output. `as const` keeps the discriminant literals for InferValue. */
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

/** Output contract of `create_agent`: the created agent's id. */
const createAgentOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'created' },
    agentId: { type: 'string', required: true },
  },
} as const

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

/** The foreground branch of every delegation tool's output value. */
interface ForegroundResult {
  kind: 'foreground'
  runId: string
  output: JsonValue[]
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundResult> {
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

/** What one tier-child start produced: a background continuable child id, or the settled foreground result. */
type TierChildOutcome = { background: true; childId: string } | { background: false; value: ForegroundResult }

/** Start one child on a pinned tier route: preflight the route, then run continuable-in-background or settle in the foreground. */
async function startTierChild(ctx: Context, config: Config, subagentProvider: SubagentProvider, tier: TierRoute, spec: { label: string; promptText: string; runInForeground: boolean }, exec: ToolRunContext): Promise<TierChildOutcome> {
  const parent = exec.agent
  if (!parent) throw new Error('crew tool requires a calling agent (exec.agent was undefined)')
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
    prompt: [{ type: 'text' as const, text: spec.promptText }],
    parent,
    agentOptions,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  }
  if (!spec.runInForeground) {
    const start = await ctx.subagents.startContinuable({
      provider: config.provider,
      label: spec.label,
      request,
      signal: exec.signal,
    })
    return { background: true, childId: start.childId as string }
  }
  return { background: false, value: await settleForegroundRun(await ctx.subagents.start(config.provider, {
    ...request,
    label: spec.label,
    signal: exec.signal,
  })) }
}

/** Install the crew delegation composition. */
export function apply(ctx: Context, config: Config) {
  const tiers = [
    { route: config.quick, description: TIER_DESCRIPTIONS.quick },
    { route: config.workhorse, description: TIER_DESCRIPTIONS.workhorse },
    { route: config.smart, description: TIER_DESCRIPTIONS.smart },
  ]
  const tierRoutes = { quick: config.quick, workhorse: config.workhorse, smart: config.smart }
  const toolNames = new Set([...tiers.map((tier) => tier.route.toolName), 'create_agent'])
  if (toolNames.size !== 4) throw new Error('crew: tier toolNames must be distinct')

  const assertProviderConfiguration = (subagentProvider: SubagentProvider) => {
    if (!subagentProvider.capabilities.agentOptions) throw new Error(`crew: provider "${subagentProvider.name}" does not support child agentOptions`)
    if (subagentProvider.prepareContinuable === undefined) throw new Error(`crew: provider "${subagentProvider.name}" does not support continuable children`)
  }

  let mounted: (() => void)[] | undefined
  const mount = (subagentProvider: SubagentProvider) => {
    assertProviderConfiguration(subagentProvider)
    const disposers = tiers.map(({ route: tier, description }) => ctx.tools.register(defineTool({
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
        const outcome = await startTierChild(ctx, config, subagentProvider, tier, {
          label: args.description,
          promptText: args.prompt,
          runInForeground: args.run_in_background === false,
        }, exec)
        return outcome.background ? { kind: 'continuable' as const, subagentId: outcome.childId } : outcome.value
      },
    })))
    mounted = [...disposers, ctx.tools.register(defineTool({
      name: 'create_agent',
      description: CREATE_AGENT_DESCRIPTION,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) label for the agent, for display.',
        },
        role: {
          type: 'string',
          required: true,
          description: 'The agent\'s standing responsibility — its charter for every later task. Keep it specific: scope, favored tools, expected output format.',
        },
        tier: {
          type: 'string',
          enum: ['quick', 'workhorse', 'smart'],
          description: 'Pinned route tier: quick (default), workhorse, or smart.',
        },
      },
      output: {
        schema: createAgentOutputSchema,
        render: (_args, value) => [{ type: 'text', text: `created agent ${value.agentId}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const tier = tierRoutes[args.tier ?? 'quick']
        const outcome = await startTierChild(ctx, config, subagentProvider, tier, {
          label: args.description,
          promptText: `Take on this standing role:\n\n${args.role}\n\nReply with a one-line confirmation that you are ready, then wait for tasks delivered as messages.`,
          runInForeground: false,
        }, exec)
        return { kind: 'created' as const, agentId: outcome.background ? outcome.childId : (outcome.value.runId as string) }
      },
    }))]
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
  else ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the crew tools will register when it appears`)

  ctx.systemPrompt.section({
    name: 'tool:crew',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => mounted === undefined || tiers.some((tier) => ctx.tools.get(tier.route.toolName, context.scope) === undefined)
      ? ''
      : 'Start independent subagent delegations together in one assistant message and continue useful work while they run.',
  })
}
