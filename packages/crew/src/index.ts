/**
 * dsh-crew — user-configured delegation routes plus a persistent role agent.
 *
 * The routing policy lives in one external YAML file (`$DSH_HOME/crew.yaml` by
 * default, or the plugin row's `configFile`). Every route is a user-named
 * choice with a short description and an ordered list of explicitly approved
 * model candidates. The model sees the route table in its system prompt and
 * passes a route name; it can neither name a provider/model nor invent a
 * fallback. Before each child starts, candidates are tried in order: routes the
 * LLM registry cannot resolve and coding-plan windows that are known to be
 * spent are skipped, and the first usable candidate wins. All candidates being
 * unusable fails the delegation; there is no unapproved escape hatch.
 *
 * The tools keep one stable name/schema per process (`subagent`,
 * `create_agent`); only the route table changes between steps. A configuration
 * change therefore never re-registers a tool in the middle of a step. The
 * policy is read once per delegation and a revision check before the child is
 * created rejects the call when the file changed during preparation.
 *
 * Invalid configuration is fail-closed: the tools stay visible but every new
 * delegation is refused until the file validates again. With `watch` enabled
 * the plugin reloads on save (including atomic replacement and symlink swaps)
 * and recovers without a restart.
 *
 * The profile mounting this plugin should disable the stock delegation rows
 * (`tool-subagent`, `tool-subagent-fork`, `tool-workflow`, `workflow-ptc`):
 * they would collide with `subagent` or open an unapproved model-selection
 * bypass. The stock control plane (`send_message` / `list_agents` /
 * `interrupt_agent`) stays.
 *
 * @module dsh-crew
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {
  SubagentActivation,
  SubagentProvider,
  SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  ConfigError,
  registerConfig,
  registerConfigStatusRoute,
  type ConfigState,
  type ConfigStore,
} from '@dsh-extensions/config'

export const name = 'dsh-crew'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

const PACKAGE_NAME = 'dsh-crew'
const CONFIG_FILE_NAME = 'crew.yaml'
const STATUS_PREFIX = '/dsh-crew'

/** Plugin-row configuration: the subagent backend plus an optional policy path. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`). */
  provider: string
  /** Policy path; empty uses `$DSH_HOME/crew.yaml`. */
  configFile?: string
}

export const Config = Schema.object({
  provider: Schema.string().default('spawn'),
  configFile: Schema.string().description(
    'Delegation policy path; empty uses $DSH_HOME/crew.yaml.',
  ),
})

/** One explicitly approved model route for a delegation. */
export interface RouteTarget {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned exact model id. */
  model: string
  /** Adapter-owned reasoning effort; omit for the model's default. */
  reasoningEffort?: string
}

/** One user-named delegation route: what it is for, and what may serve it. */
export interface DelegationRoute {
  /** Short guidance the model uses to pick this route. */
  desc: string
  /** Approved candidates in preference order; the first usable one wins. */
  candidates: readonly RouteTarget[]
}

/** The whole `crew.yaml` document. */
export interface CrewPolicy {
  routes: Record<string, DelegationRoute>
}

const ROOT_KEYS = new Set(['routes'])
const ROUTE_KEYS = new Set(['desc', 'candidates'])
const CANDIDATE_KEYS = new Set(['provider', 'model', 'reasoningEffort'])
const ROUTE_ID = /^[a-z][a-z0-9_-]*$/u
const MAX_ROUTE_ID_LENGTH = 40
const FORBIDDEN_ROUTE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(path, 'expected an object')
  return value
}

function rejectUnknown(raw: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(path, `unknown key "${key}"`)
  }
}

function requiredString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(`${path}.${key}`, 'expected a non-empty string')
  }
  return value.trim()
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(`${path}.${key}`, 'expected a non-empty string')
  }
  return value.trim()
}

/** Validate one YAML document into a delegation policy. Throws {@link ConfigError}. */
export function parseCrewPolicy(document: unknown): CrewPolicy {
  const root = asRecord(document, 'config')
  rejectUnknown(root, ROOT_KEYS, 'config')
  const rawRoutes = asRecord(root.routes, 'config.routes')
  const entries = Object.entries(rawRoutes)
  if (entries.length === 0) fail('config.routes', 'needs at least one route')
  const routes: Record<string, DelegationRoute> = {}
  for (const [id, routeValue] of entries) {
    const path = `config.routes.${id}`
    if (!ROUTE_ID.test(id) || id.length > MAX_ROUTE_ID_LENGTH) {
      fail(
        'config.routes',
        `route id "${id}" must start with a lowercase letter and contain only lowercase letters, digits, "_" or "-" (at most ${MAX_ROUTE_ID_LENGTH} characters)`,
      )
    }
    if (FORBIDDEN_ROUTE_IDS.has(id)) fail(path, `"${id}" is not a usable route id`)
    const raw = asRecord(routeValue, path)
    rejectUnknown(raw, ROUTE_KEYS, path)
    const desc = requiredString(raw, 'desc', path)
    const rawCandidates = raw.candidates
    if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
      fail(`${path}.candidates`, 'needs at least one candidate')
    }
    const candidates = rawCandidates.map((candidate, index) => {
      const candidatePath = `${path}.candidates[${index}]`
      const record = asRecord(candidate, candidatePath)
      rejectUnknown(record, CANDIDATE_KEYS, candidatePath)
      const provider = requiredString(record, 'provider', candidatePath)
      const model = requiredString(record, 'model', candidatePath)
      const reasoningEffort = optionalString(record, 'reasoningEffort', candidatePath)
      const target: RouteTarget = { provider, model }
      if (reasoningEffort !== undefined) target.reasoningEffort = reasoningEffort
      return target
    })
    routes[id] = { desc, candidates }
  }
  return { routes }
}

/** A short, single-line rendering of a preflight failure. */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const single = message.replaceAll(/\s+/gu, ' ').trim()
  return single.length > 200 ? `${single.slice(0, 197)}…` : single
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
    ...(target.reasoningEffort === undefined || target.reasoningEffort === ''
      ? {}
      : { reasoningEffort: ReasoningEffortId(target.reasoningEffort) }),
  }
}

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
  get(
    provider: string,
    options?: { maxAgeMs?: number; force?: boolean },
  ): Promise<PlanUsageSnapshotShim | undefined>
}

/** The context surface route selection reads — structurally satisfied by Context, narrowed so tests can stub it. */
export interface RouteSelectionContext {
  llm: { resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> }
  logger: { warn(message: string, ...args: unknown[]): void }
  get(name: string): unknown
}

/** Whether any reported window sits at its limit with the reset still ahead. */
export function anyWindowExhausted(
  snapshot: PlanUsageSnapshotShim | undefined,
  now: number,
): boolean {
  if (snapshot === undefined) return false
  return [snapshot.fiveHour, snapshot.weekly, snapshot.monthly, snapshot.monthlyMcp].some(
    (window) => {
      if (window === undefined || typeof window.percent !== 'number' || window.percent < 100)
        return false
      return window.resetAt === undefined || window.resetAt > now
    },
  )
}

/** A quota read may serve from cache; older than this it refetches upstream. */
const PLAN_SNAPSHOT_MAX_AGE_MS = 60_000
/** A routing hint must never delay the delegation it routes: all quota reads share this budget. */
const PLAN_READ_BUDGET_MS = 2_000

/** Narrow the optional `planUsage` service without an assertion. */
function isPlanUsageService(value: unknown): value is PlanUsageServiceShim {
  return (
    typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function'
  )
}

/** A provider is exhausted only on a known full window; absence, failure, and timeout are unknown. */
async function providerExhausted(
  ctx: RouteSelectionContext,
  provider: string,
  deadline: number,
): Promise<boolean> {
  const planUsage = ctx.get('planUsage')
  if (!isPlanUsageService(planUsage)) return false
  const remaining = deadline - Date.now()
  if (remaining <= 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const budget = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), remaining)
    })
    const snapshot = await Promise.race([
      planUsage.get(provider, { maxAgeMs: PLAN_SNAPSHOT_MAX_AGE_MS }),
      budget,
    ])
    return anyWindowExhausted(snapshot, Date.now())
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One candidate that could not serve this delegation, and why. */
export interface SkippedCandidate {
  target: RouteTarget
  reason: string
}

/** The candidate one delegation runs on, plus the candidates skipped before it. */
export interface RouteSelection {
  /** The approved candidate that served the delegation. */
  target: RouteTarget
  /**
   * The LLM service's resolved call config for that candidate. When it names
   * no effort (the model declares no default), `startChild` clears any effort
   * inherited from a parent on the same route through the child's own model
   * selection, before its first step runs.
   */
  config: LlmCallConfig
  skipped: readonly SkippedCandidate[]
}

/**
 * Pick the candidate one delegation runs on.
 *
 * Candidates are preflighted in their configured order; a route the LLM
 * registry cannot resolve or a provider whose coding-plan window is known to
 * be spent is skipped. Exhausting every candidate throws — the caller never
 * falls back to an unapproved model, and an aborted call never degrades.
 */
export async function selectRoute(
  ctx: RouteSelectionContext,
  policy: CrewPolicy,
  routeId: string,
  signal: AbortSignal,
): Promise<RouteSelection> {
  const route = Object.hasOwn(policy.routes, routeId) ? policy.routes[routeId] : undefined
  if (route === undefined) {
    const available = Object.keys(policy.routes).join(', ')
    throw new Error(
      `crew: unknown delegation route "${routeId}"${available === '' ? '' : `; available routes: ${available}`}`,
    )
  }
  const deadline = Date.now() + PLAN_READ_BUDGET_MS
  const quota = new Map<string, Promise<boolean>>()
  const exhausted = (provider: string): Promise<boolean> => {
    const cached = quota.get(provider)
    if (cached !== undefined) return cached
    const read = providerExhausted(ctx, provider, deadline)
    quota.set(provider, read)
    return read
  }
  const skipped: SkippedCandidate[] = []
  for (const target of route.candidates) {
    let config: LlmCallConfig
    try {
      config = await ctx.llm.resolveCallConfig(callConfigOf(target), signal)
    } catch (error) {
      // Cancellation is the caller's own decision, never a routing signal.
      if (signal.aborted) throw error
      skipped.push({ target, reason: `route unavailable (${failureDetail(error)})` })
      continue
    }
    if (await exhausted(target.provider)) {
      skipped.push({ target, reason: 'coding-plan window exhausted' })
      continue
    }
    return { target, config, skipped }
  }
  const detail = skipped.map((skip) => `${routeName(skip.target)} (${skip.reason})`).join(', ')
  throw new Error(
    `crew: no approved candidate for route "${routeId}" can serve this delegation: ${detail}`,
  )
}

/** One route's fallback reason as the tool result's notice. */
function selectionNotice(routeId: string, selection: RouteSelection): string | undefined {
  if (selection.skipped.length === 0) return undefined
  const skipped = selection.skipped
    .map((skip) => `${routeName(skip.target)} (${skip.reason})`)
    .join(', ')
  return `route "${routeId}" ran on ${routeName(selection.target)} after skipping ${skipped}`
}

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: readonly unknown[]): string {
  return values
    .filter(
      (value): value is { text: string } =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { type?: unknown }).type === 'text' &&
        typeof (value as { text?: unknown }).text === 'string',
    )
    .map((value) => value.text)
    .join('')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append provider-authored failure detail and the child's preserved partial answer to a stop-reason error. */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return `${error}${diagnostic}${text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`}`
}

/** The foreground branch of every delegation tool's output value. */
interface ForegroundResult {
  kind: 'foreground'
  runId: string
  output: JsonValue[]
}

/** Outcome of releasing one activation, captured instead of thrown so a result failure survives. */
type DisposalOutcome = { ok: true } | { ok: false; error: unknown }

/**
 * Collect and release one foreground activation.
 *
 * The activation's start signal owns publication only: once the child is
 * accepted, the caller owns cancellation, so an abort must `dispose()` the
 * activation — that is what stops the running child and lets its result settle.
 * Both teardown and the result are awaited before this returns, so the tool
 * call never reports an outcome the child is still running against.
 */
async function settleForegroundRun(
  activation: SubagentActivation,
  signal: AbortSignal,
): Promise<ForegroundResult> {
  let release: Promise<DisposalOutcome> | undefined
  /** Start (or reuse) the one release this activation ever needs; dispose is idempotent. */
  const dispose = (): Promise<DisposalOutcome> =>
    (release ??= Promise.resolve()
      .then(() => activation.dispose())
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ))
  const cancel = (): void => {
    void dispose()
  }
  // Covers an abort that landed while `startActivation` was still publishing.
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  try {
    const [execution] = await Promise.allSettled([
      activation.result.then((result) => {
        const error = stopReasonError(result)
        if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
        return {
          kind: 'foreground' as const,
          runId: activation.childId,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A28: ContentBlocks travel the session log as lossless JSON, but the tool's output schema types this value as the broader JsonValue[] and the SDK block interfaces carry no index signature; no public converter bridges the two.
          output: [...result.output] as unknown as JsonValue[],
        }
      }),
    ])
    // A normal completion releases here; an aborted activation already released
    // in the listener, and the result settled because of it.
    const disposal = await dispose()
    if (execution.status === 'rejected') {
      if (!disposal.ok)
        throw new AggregateError(
          [execution.reason, disposal.error],
          `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.error)}`,
        )
      throw execution.reason
    }
    if (!disposal.ok) throw disposal.error
    return execution.value
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** What one delegation start produced: a background child id, or the settled foreground result. */
type ChildOutcome =
  | { background: true; childId: string; selection: RouteSelection }
  | { background: false; value: ForegroundResult; selection: RouteSelection }

/** The error a delegation reports while the policy file is not usable. */
function unusablePolicyError(state: ConfigState<CrewPolicy>): Error {
  const reason = state.error ?? 'it has not been read yet'
  return new Error(
    `crew: the delegation configuration ${state.file} is not usable (${reason}); fix that file and retry — no new delegation is allowed until it validates`,
  )
}

/**
 * Start one child on the requested route.
 *
 * The policy revision is captured before route selection and re-checked before
 * the child exists: if the file changed while this call was preparing, the
 * call fails and the caller retries against the new policy instead of running
 * a stale one. A change after the child exists does not touch it.
 */
async function startChild(
  ctx: Context,
  config: Config,
  subagentProvider: SubagentProvider,
  store: ConfigStore<CrewPolicy>,
  log: { warn(message: string, ...args: unknown[]): void },
  spec: { route: string; label: string; promptText: string; runInForeground: boolean },
  exec: ToolRunContext,
): Promise<ChildOutcome> {
  const parent = exec.agent
  if (!parent) throw new Error('crew tool requires a calling agent (exec.agent was undefined)')
  const before = store.state()
  if (before.value === undefined) throw unusablePolicyError(before)
  exec.signal.throwIfAborted()
  const selection = await selectRoute(ctx, before.value, spec.route, exec.signal)
  // Use the resolved config, not the candidate as written: the resolver
  // materializes the model's default effort, which is what keeps a
  // same-provider/same-model child from inheriting the parent's effort.
  const agentOptions = selection.config
  if (ctx.subagents.getProvider(config.provider) !== subagentProvider)
    throw new Error(
      `subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`,
    )
  if (store.state().revision !== before.revision)
    throw new Error(
      'crew: the delegation route policy changed while preparing this delegation; retry it',
    )
  const maxDepth = ctx.subagents.resolveMaxDepth()
  const request = {
    prompt: [{ type: 'text' as const, text: spec.promptText }],
    parent,
    agentOptions,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  }
  const notice = selectionNotice(spec.route, selection)
  if (notice !== undefined) log.warn('crew: %s', notice)
  // When the resolver has no default effort to materialize, the SDK's child
  // merge would inherit the parent's effort on an identical provider/model
  // route. The supported way to express "adapter default, not the previous
  // effort" is the child's own model selection: omit the effort there. The
  // creation listener runs before the queued prompt's first step, so this is
  // the selection the child actually uses.
  const clearInheritedEffort = selection.config.reasoningEffort === undefined
  const childId = clearInheritedEffort ? SessionId(randomUUID()) : undefined
  const stopCreated = clearInheritedEffort
    ? ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== childId) return
        agent.model.select({
          provider: selection.config.provider,
          model: selection.config.model,
        })
      })
    : undefined
  let activation: SubagentActivation
  try {
    // One activation API for both modes: only the result recipient (and
    // therefore whether the model is notified) differs. Background children
    // stay resident and are released through the host's control plane — this
    // tool call's end, including a later abort of its signal, never touches
    // them. A foreground child is settled and disposed by this call itself.
    activation = await ctx.subagents.startActivation({
      provider: config.provider,
      ...(childId === undefined ? {} : { childId }),
      label: spec.label,
      request,
      signal: exec.signal,
      delivery: spec.runInForeground ? 'caller' : 'parent',
    })
  } finally {
    stopCreated?.()
  }
  if (!spec.runInForeground) {
    return { background: true, childId: activation.childId, selection }
  }
  return {
    background: false,
    value: await settleForegroundRun(activation, exec.signal),
    selection,
  }
}

/** Verify one provider supports everything the crew tools mount against. */
function assertProviderConfiguration(subagentProvider: SubagentProvider) {
  if (!subagentProvider.capabilities.agentOptions)
    throw new Error(`crew: provider "${subagentProvider.name}" does not support child agentOptions`)
  if (subagentProvider.prepareContinuable === undefined)
    throw new Error(
      `crew: provider "${subagentProvider.name}" does not support continuable children`,
    )
}

/** Verified route metadata echoed by every delegation result. */
const routeResultFields = {
  route: { type: 'string', required: true, description: 'The route the caller asked for.' },
  provider: { type: 'string', required: true, description: 'LLM provider that serves the child.' },
  model: { type: 'string', required: true, description: 'Exact model that serves the child.' },
  reasoningEffort: { type: 'string', description: 'Reasoning effort when the candidate pins one.' },
  notice: {
    type: 'string',
    description: 'Present when an earlier approved candidate was skipped.',
  },
} as const

/** Shared output contract of the delegation tools: a continuable child id, or the collected foreground output. */
const delegationOutputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'continuable' },
        subagentId: { type: 'string', required: true },
        ...routeResultFields,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'foreground' },
        runId: { type: 'string', required: true },
        output: { type: 'array', required: true, items: { type: 'json' } },
        ...routeResultFields,
      },
    },
  ],
} as const

/** Output contract of `create_agent`: the created agent's id and the serving route. */
const createAgentOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'created' },
    agentId: { type: 'string', required: true },
    ...routeResultFields,
  },
} as const

const CREATE_AGENT_DESCRIPTION =
  'Create a persistent named agent with a standing role and get its id. The agent confirms its role, then idles until you send it tasks with `send_message`; reuse it for repeated work of the same kind instead of re-stating context on every delegation. `route` is required and names one route from the delegation route table in your system prompt; the configuration decides the model. `list_agents` shows your live agents; `interrupt_agent` stops one.'

const SUBAGENT_DESCRIPTION =
  'Delegate a self-contained task to a subagent (a separate agent that works in its own context) and get its result. `route` is required and names one route from the delegation route table in your system prompt; pick the route whose description matches the task. The configuration decides the model and may run an explicitly approved fallback candidate. The subagent returns its result, not its intermediate steps. It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when the run settles.'

const ROUTE_PARAMETER_DESCRIPTION =
  'Required. One route name from the delegation route table in your system prompt.'

const PROMPT_PARAMETER_DESCRIPTION =
  "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."

/** One route table entry: a name plus one line of user-authored guidance. */
function routeLine(id: string, desc: string): string {
  return `- ${id}: ${desc.replaceAll(/\s+/gu, ' ').trim()}`
}

/** The per-step system-prompt section: the current route table, or why delegation is disabled. */
export function renderRouteTable(state: ConfigState<CrewPolicy>): string {
  if (!state.loaded) return ''
  if (state.value === undefined) {
    return `Delegation is disabled: the crew configuration ${state.file} is not usable (${state.error ?? 'unknown error'}). The delegation tools will refuse every call; tell the user to fix that file.`
  }
  return [
    "Delegation routes from the user's crew configuration. `subagent` and `create_agent` require `route`: pick the route whose description matches the task. The model, and any approved fallback, is fixed by the configuration; you cannot choose or override it.",
    ...Object.entries(state.value.routes).map(([id, route]) => routeLine(id, route.desc)),
    'Start independent delegations together in one assistant message and continue useful work while they run.',
  ].join('\n')
}

/** Install the crew delegation composition. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger(PACKAGE_NAME)
  const store = registerConfig(ctx, {
    filename: CONFIG_FILE_NAME,
    configFile: config.configFile,
    validate: parseCrewPolicy,
    watch: true,
    logger: log,
  })
  registerConfigStatusRoute(ctx, {
    prefix: STATUS_PREFIX,
    title: 'crew 委派路由',
    recovery: 'auto',
    store,
  })

  let lastValid: boolean | undefined
  store.subscribe((state) => {
    if (state.value === undefined) {
      log.error(
        'crew: %s is not usable: %s — new delegations are refused until it is fixed',
        state.file,
        state.error ?? 'unknown error',
      )
    } else if (lastValid === false) {
      log.info('crew: %s is valid again; delegations resumed', state.file)
    } else {
      log.info(
        `crew: loaded ${Object.keys(state.value.routes).length} delegation route(s) from ${state.file}`,
      )
    }
    lastValid = state.value !== undefined
  })
  await store.ready

  let mounted: (() => void)[] | undefined
  const mount = (subagentProvider: SubagentProvider) => {
    assertProviderConfiguration(subagentProvider)
    const subagentTool = defineTool({
      name: 'subagent',
      description: SUBAGENT_DESCRIPTION,
      parameters: {
        route: {
          type: 'string',
          required: true,
          description: ROUTE_PARAMETER_DESCRIPTION,
        },
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
          description:
            'Defaults to true. Set false only when your next action depends on the result.',
        },
      },
      output: {
        schema: delegationOutputSchema,
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              value.kind === 'continuable'
                ? `started subagent ${value.subagentId}`
                : outputValueText(value.output),
              ` on route "${value.route}" (${value.provider}/${value.model})`,
              value.notice === undefined ? '' : `\n[crew] ${value.notice}`,
            ].join(''),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const outcome = await startChild(
          ctx,
          config,
          subagentProvider,
          store,
          log,
          {
            route: args.route,
            label: args.description,
            promptText: args.prompt,
            runInForeground: args.run_in_background === false,
          },
          exec,
        )
        const selection = outcome.selection
        const notice = selectionNotice(args.route, selection)
        const meta = {
          route: args.route,
          provider: selection.config.provider,
          model: selection.config.model,
          ...(selection.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.config.reasoningEffort }),
          ...(notice === undefined ? {} : { notice }),
        }
        if (outcome.background) {
          return { kind: 'continuable' as const, subagentId: outcome.childId, ...meta }
        }
        return { ...outcome.value, ...meta }
      },
    })

    const createAgentTool = defineTool({
      name: 'create_agent',
      description: CREATE_AGENT_DESCRIPTION,
      parameters: {
        route: {
          type: 'string',
          required: true,
          description: ROUTE_PARAMETER_DESCRIPTION,
        },
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) label for the agent, for display.',
        },
        role: {
          type: 'string',
          required: true,
          description:
            "The agent's standing responsibility — its charter for every later task. Keep it specific: scope, favored tools, expected output format.",
        },
      },
      output: {
        schema: createAgentOutputSchema,
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `created agent ${value.agentId} on route "${value.route}" (${value.provider}/${value.model})`,
              value.notice === undefined ? '' : `\n[crew] ${value.notice}`,
            ].join(''),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const outcome = await startChild(
          ctx,
          config,
          subagentProvider,
          store,
          log,
          {
            route: args.route,
            label: args.description,
            promptText: `Take on this standing role:\n\n${args.role}\n\nReply with a one-line confirmation that you are ready, then wait for tasks delivered as messages.`,
            runInForeground: false,
          },
          exec,
        )
        const agentId = outcome.background ? outcome.childId : outcome.value.runId
        const selection = outcome.selection
        const notice = selectionNotice(args.route, selection)
        return {
          kind: 'created' as const,
          agentId,
          route: args.route,
          provider: selection.config.provider,
          model: selection.config.model,
          ...(selection.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.config.reasoningEffort }),
          ...(notice === undefined ? {} : { notice }),
        }
      },
    })

    mounted = [ctx.tools.register(subagentTool), ctx.tools.register(createAgentTool)]
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
  else
    log.info(
      `subagent provider "${config.provider}" not registered yet; the crew tools will register when it appears`,
    )

  ctx.systemPrompt.section({
    name: 'tool:crew',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    // Route descriptions are literal user text; `{{...}}` in them is not a
    // prompt variable.
    interpolate: false,
    text: () => (mounted === undefined ? '' : renderRouteTable(store.state())),
  })
}
