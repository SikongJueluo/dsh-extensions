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
 * depth 读宿主 `subagent.maxDepth` 设置。每档可再声明一条 fallback：创建子代理
 * 前预检钉死路由，路由不可用（provider/模型/effort 解析失败）或其套餐窗口用尽
 * （`planUsage` 软依赖）时改走 fallback，两边都不行才报错。
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
import { ReasoningEffortId, type ContentBlock, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'crew'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

/** One exact LLM route a delegation can run on. */
export interface RouteTarget {
  /** Registered LLM provider route for every child of this tier. */
  provider: string
  /** Provider-owned exact model id. */
  model: string
  /** Adapter-owned reasoning effort; omit for the model's default. */
  reasoningEffort?: string
}

/** One fixed delegation tier: a model-facing tool name plus its pinned LLM route. */
export interface TierRoute extends RouteTarget {
  /** Model-facing tool name; must be distinct across tiers. */
  toolName: string
  /**
   * Route used when the pinned route cannot serve a delegation (unregistered
   * route, unknown model, or an exhausted coding-plan window). An empty
   * `provider`/`model` disables it and restores the fail-loud behaviour.
   */
  fallback?: RouteTarget
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

/** One tier's fallback as a fresh Schema.object; empty strings mean "no fallback". */
const tierFallback = (defaults: RouteTarget | undefined) => Schema.object({
  provider: Schema.string().default(defaults?.provider ?? ''),
  model: Schema.string().default(defaults?.model ?? ''),
  reasoningEffort: Schema.string().default(defaults?.reasoningEffort ?? ''),
}).default({ provider: defaults?.provider ?? '', model: defaults?.model ?? '', reasoningEffort: defaults?.reasoningEffort ?? '' })

/** One tier's defaults as a fresh Schema.object (schemastery schemas are not safely shareable across fields). */
const tierRoute = (defaults: TierRoute) => Schema.object({
  toolName: Schema.string().default(defaults.toolName),
  provider: Schema.string().default(defaults.provider),
  model: Schema.string().default(defaults.model),
  reasoningEffort: Schema.string().default(defaults.reasoningEffort ?? 'max'),
  fallback: tierFallback(defaults.fallback),
}).default(defaults)

export const Config = Schema.object({
  provider: Schema.string().default('spawn'),
  quick: tierRoute({
    toolName: 'subagent_quick',
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'max',
    fallback: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  }),
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
      notice: { type: 'string', description: 'Present when the tier ran on its fallback route' },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', required: true, const: 'foreground' },
      runId: { type: 'string', required: true },
      output: { type: 'array', required: true, items: { type: 'json' } },
      notice: { type: 'string', description: 'Present when the tier ran on its fallback route' },
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
    notice: { type: 'string', description: 'Present when the tier ran on its fallback route' },
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

// ── Route selection ──────────────────────────────────────────────────────────
// A pinned route can be unusable for reasons the LLM registry alone cannot
// answer: the route may vanish from the adapter topology, its model may be
// renamed, or its coding-plan window may already be spent. The first two fail
// the `resolveCallConfig` preflight; the third is visible only through the
// `planUsage` service (dsh-plan-usage), read optionally. Whenever the tier
// names a fallback, a blocked delegation runs there instead of failing.

/** Quota window facts as dsh-plan-usage reports them. */
interface PlanUsageWindowShim {
  percent?: number
  resetAt?: number
}

/** One provider's quota snapshot as dsh-plan-usage reports it. */
interface PlanUsageSnapshotShim {
  fiveHour?: PlanUsageWindowShim
  weekly?: PlanUsageWindowShim
  monthly?: PlanUsageWindowShim
  monthlyMcp?: PlanUsageWindowShim
}

/** Minimal `planUsage` surface consumed by route selection; absent plugin reads as `undefined`. */
interface PlanUsageServiceShim {
  get(provider: string, options?: { maxAgeMs?: number; force?: boolean }): Promise<PlanUsageSnapshotShim | undefined>
}

/** The context surface route selection reads — structurally satisfied by Context, narrowed so tests can stub it. */
export interface RouteSelectionContext {
  llm: { resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> }
  logger: { warn(message: string, ...args: unknown[]): void }
  get(name: string): unknown
}

/** Why the pinned route cannot serve a delegation. */
interface RouteBlocker {
  /** `unavailable` is a hard preflight failure; `exhausted` only means "spend the fallback first". */
  kind: 'unavailable' | 'exhausted'
  detail: string
  /** The preflight failure, rethrown when no fallback is configured. */
  error?: unknown
}

/** The route one delegation should run on, plus why the pinned one was skipped. */
export interface RouteSelection {
  target: RouteTarget
  /** Model-facing one-liner recorded on the delegation's output when the fallback was used. */
  notice?: string
}

/** The tier's fallback, when both halves are named. */
export function fallbackTarget(tier: TierRoute): RouteTarget | undefined {
  const fallback = tier.fallback
  if (fallback === undefined || fallback.provider === '' || fallback.model === '') return undefined
  return fallback
}

/** Whether any reported window sits at its limit with the reset still ahead. */
export function anyWindowExhausted(snapshot: PlanUsageSnapshotShim | undefined, now: number): boolean {
  if (snapshot === undefined) return false
  return [snapshot.fiveHour, snapshot.weekly, snapshot.monthly, snapshot.monthlyMcp].some((window) => {
    if (window === undefined || typeof window.percent !== 'number' || window.percent < 100) return false
    return window.resetAt === undefined || window.resetAt > now
  })
}

/** `<provider>/<model>`, for messages. */
export function routeName(target: RouteTarget): string {
  return `${target.provider}/${target.model}`
}

/** One target as an LLM call config. */
export function callConfigOf(target: RouteTarget): LlmCallConfig {
  return {
    provider: target.provider,
    model: target.model,
    ...(target.reasoningEffort !== undefined && target.reasoningEffort !== '' ? { reasoningEffort: ReasoningEffortId(target.reasoningEffort) } : {}),
  }
}

/** A short, single-line rendering of a preflight failure. */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const single = message.replace(/\s+/g, ' ').trim()
  return single.length > 200 ? `${single.slice(0, 197)}…` : single
}

/** A quota read may serve from cache; older than this it refetches upstream. */
const PLAN_SNAPSHOT_MAX_AGE_MS = 60_000
/** A routing hint must never delay the delegation it routes: a quota read gets this budget. */
const PLAN_READ_BUDGET_MS = 2_000

/** Read the pinned route's coding-plan snapshot; any failure or overrun reads as "no quota data". */
async function planSnapshotOf(ctx: RouteSelectionContext, provider: string): Promise<PlanUsageSnapshotShim | undefined> {
  const planUsage = ctx.get('planUsage') as PlanUsageServiceShim | undefined
  if (planUsage === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const budget = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PLAN_READ_BUDGET_MS)
    })
    return await Promise.race([planUsage.get(provider, { maxAgeMs: PLAN_SNAPSHOT_MAX_AGE_MS }), budget])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Why the pinned route cannot serve a delegation right now, or `undefined` when it can. */
async function pinnedRouteBlocker(ctx: RouteSelectionContext, tier: TierRoute, signal: AbortSignal): Promise<RouteBlocker | undefined> {
  try {
    await ctx.llm.resolveCallConfig(callConfigOf(tier), signal)
  } catch (error) {
    // Cancellation is the caller's own decision, never a routing signal.
    if (signal.aborted) throw error
    return { kind: 'unavailable', detail: `route unavailable (${failureDetail(error)})`, error }
  }
  const snapshot = await planSnapshotOf(ctx, tier.provider)
  if (anyWindowExhausted(snapshot, Date.now())) return { kind: 'exhausted', detail: 'coding-plan window exhausted' }
  return undefined
}

/**
 * Pick the route one delegation runs on: the tier's pinned route, or its
 * fallback when the pinned route is unavailable or its coding-plan window is
 * spent. Without a usable fallback the pinned route is preflighted and any
 * failure is rethrown (fail loud); an exhausted window without a fallback
 * stays on the pinned route, where dsh-auto-continue resumes it at the reset.
 */
export async function selectTierRoute(ctx: RouteSelectionContext, tier: TierRoute, signal: AbortSignal): Promise<RouteSelection> {
  const blocker = await pinnedRouteBlocker(ctx, tier, signal)
  if (blocker === undefined) return { target: tier }
  const fallback = fallbackTarget(tier)
  if (fallback === undefined) {
    if (blocker.kind === 'unavailable') throw blocker.error
    ctx.logger.warn('crew: %s is %s and this tier names no fallback — delegating anyway', routeName(tier), blocker.detail)
    return { target: tier }
  }
  try {
    await ctx.llm.resolveCallConfig(callConfigOf(fallback), signal)
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(
      `crew: neither ${routeName(tier)} (${blocker.detail}) nor its fallback ${routeName(fallback)} (route unavailable: ${failureDetail(error)}) can serve this delegation`,
      { cause: blocker.error ?? error },
    )
  }
  const notice = `${routeName(tier)} ${blocker.detail} — ran on the fallback ${routeName(fallback)}`
  ctx.logger.warn('crew: %s', notice)
  return { target: fallback, notice }
}

/** What one tier-child start produced: a background continuable child id, or the settled foreground result. */
type TierChildOutcome = { background: true; childId: string; notice?: string } | { background: false; value: ForegroundResult; notice?: string }

/** Start one child on a pinned tier route: select the route (with its fallback), then run continuable-in-background or settle in the foreground. */
async function startTierChild(ctx: Context, config: Config, subagentProvider: SubagentProvider, tier: TierRoute, spec: { label: string; promptText: string; runInForeground: boolean }, exec: ToolRunContext): Promise<TierChildOutcome> {
  const parent = exec.agent
  if (!parent) throw new Error('crew tool requires a calling agent (exec.agent was undefined)')
  exec.signal.throwIfAborted()
  const selection = await selectTierRoute(ctx, tier, exec.signal)
  const agentOptions = callConfigOf(selection.target)
  if (ctx.subagents.getProvider(config.provider) !== subagentProvider) throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
  const maxDepth = ctx.subagents.resolveMaxDepth()
  const request = {
    prompt: [{ type: 'text' as const, text: spec.promptText }],
    parent,
    agentOptions,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  }
  const notice = selection.notice
  if (!spec.runInForeground) {
    const start = await ctx.subagents.startContinuable({
      provider: config.provider,
      label: spec.label,
      request,
      signal: exec.signal,
    })
    return { background: true, childId: start.childId as string, ...(notice !== undefined ? { notice } : {}) }
  }
  return { background: false, value: await settleForegroundRun(await ctx.subagents.start(config.provider, {
    ...request,
    label: spec.label,
    signal: exec.signal,
  })), ...(notice !== undefined ? { notice } : {}) }
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
          text: (value.kind === 'continuable' ? `started subagent ${value.subagentId}` : outputValueText(value.output)) +
            (value.notice === undefined ? '' : `\n[crew] ${value.notice}`),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const outcome = await startTierChild(ctx, config, subagentProvider, tier, {
          label: args.description,
          promptText: args.prompt,
          runInForeground: args.run_in_background === false,
        }, exec)
        const notice = outcome.notice
        if (outcome.background) {
          return { kind: 'continuable' as const, subagentId: outcome.childId, ...(notice !== undefined ? { notice } : {}) }
        }
        return { ...outcome.value, ...(notice !== undefined ? { notice } : {}) }
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
        render: (_args, value) => [{
          type: 'text',
          text: `created agent ${value.agentId}` + (value.notice === undefined ? '' : `\n[crew] ${value.notice}`),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const tier = tierRoutes[args.tier ?? 'quick']
        const outcome = await startTierChild(ctx, config, subagentProvider, tier, {
          label: args.description,
          promptText: `Take on this standing role:\n\n${args.role}\n\nReply with a one-line confirmation that you are ready, then wait for tasks delivered as messages.`,
          runInForeground: false,
        }, exec)
        const agentId = outcome.background ? outcome.childId : (outcome.value.runId as string)
        const notice = outcome.notice
        return { kind: 'created' as const, agentId, ...(notice !== undefined ? { notice } : {}) }
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
