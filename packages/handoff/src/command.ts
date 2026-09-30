/**
 * `/handoff` command registration: model-choice dialog plus the briefing
 * instruction handed to the current agent.
 *
 * @module dsh-handoff/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { COMMAND_NAME, DEFAULT_BRIEF_DIR, PACKAGE_NAME } from './identity.js'
import { briefInstruction, startHandoffWatch, timestampSlug, type HandoffRuntime, type ModelChoice, type PendingHandoff } from './brief.js'
import { defaultRoute, sessionRoute, type RouteSummary } from './selection.js'

/** Label shown for "keep this session's preset and model". */
const LABEL_INHERIT = '继承当前会话'
/** Label shown for "same as manually clicking New Session". */
const LABEL_DEFAULT = '全局默认'

/** How long the confirmation card may sit unanswered before we fall back to the default choice. */
const CONFIRM_TIMEOUT_MS = 60_000
/** Budget for enumerating provider/model routes before the dialog falls back to the two base options + custom input. */
const MODEL_LIST_TIMEOUT_MS = 8_000
/** Keep the dialog list sane; beyond this, custom input is the escape hatch. */
const MODEL_MENU_LIMIT = 50
/** Prefix flag selecting the fresh session's model without a dialog. */
const MODEL_FLAG = '--model'

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

/** Resolve a {@link PendingHandoff} key for an agent (its session id as a plain string). */
function keyOf(agent: Agent): string {
  return String(agent.id)
}

/** One enumerable provider/model route offered by the dialog. */
interface ModelRoute {
  readonly provider: string
  /** Provider display name (shown to the operator instead of the route id). */
  readonly providerName: string
  readonly model: string
  readonly name: string
}

/** One dialog row: the label the operator clicks plus the route it selects. */
interface MenuEntry {
  readonly label: string
  readonly route: ModelRoute
}

function menuDescription(route: ModelRoute): string | undefined {
  const parts = [route.providerName]
  if (route.name !== route.model) parts.push(route.model)
  return parts.join(' · ')
}

/**
 * Build clickable rows whose labels are the models' display names — the
 * operator should never have to know a `provider/model` spelling. A display
 * name claimed by several providers gets its route id appended.
 */
function buildMenu(routes: readonly ModelRoute[]): MenuEntry[] {
  const counts = new Map<string, number>()
  for (const route of routes) counts.set(route.name, (counts.get(route.name) ?? 0) + 1)
  return routes.map(route => ({
    label: (counts.get(route.name) ?? 0) > 1 ? `${route.name} (${route.provider})` : route.name,
    route,
  }))
}

/** Validate an explicit `provider/model` spelling (membership is advisory; routing validates later). */
function parseModelFlagValue(spec: string): { provider: string; model: string } | undefined {
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) return undefined
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
}

/**
 * Resolve a typed spelling against known routes: `provider/model`, a unique
 * model id, or a unique model display name.
 */
function parseModelSpec(text: string, routes: readonly ModelRoute[]): ModelRoute | undefined {
  const spec = text.trim()
  if (spec.length === 0) return undefined
  const explicit = parseModelFlagValue(spec)
  if (explicit !== undefined) {
    return routes.find((route) => route.provider === explicit.provider && route.model === explicit.model)
  }
  const byId = routes.filter((route) => route.model === spec)
  if (byId.length === 1) return byId[0]
  const byName = routes.filter((route) => route.name === spec)
  return byName.length === 1 ? byName[0] : undefined
}

/**
 * Enumerate provider/model routes the same way the Web /model catalog does
 * (`listProviders` → `listModels`), bounded by {@link MODEL_LIST_TIMEOUT_MS};
 * slow or failing enumeration degrades to the two base options plus custom
 * input rather than blocking the dialog.
 */
async function listModelRoutes(ctx: Context): Promise<ModelRoute[]> {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  const collect = (async () => {
    const providers = await llm.listProviders()
    const routes: ModelRoute[] = []
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        for (const model of models) {
          routes.push({
            provider: model.provider,
            providerName: provider.name,
            model: model.id,
            name: model.name,
          })
        }
      } catch {
        // Per-provider failure degrades to omitting that provider's models.
      }
    }
    return routes
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ModelRoute[]>(resolve => {
    timer = setTimeout(() => resolve([]), MODEL_LIST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([collect, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Dialog outcome: a resolved choice, or a cancellation with an optional user-facing reason. */
type AskOutcome = { kind: 'choice'; choice: ModelChoice } | { kind: 'cancel'; reason?: string }

/**
 * The shipped question-card path: a flat clickable list of model display names
 * plus two base options, and a typed spelling as the escape hatch. Used by
 * deployments with no browser half (TUI/headless) and as the fallback when the
 * browser picker never answers.
 *
 * The ask deliberately does NOT ride `invocation.signal`: the UI request's
 * lifetime must not cancel an unanswered question — our own timeout is the
 * fallback.
 */
async function askChoiceCard(
  ctx: Context,
  agent: Agent,
  routes: readonly ModelRoute[],
  inherited: RouteSummary | undefined,
  fallback: RouteSummary | undefined,
): Promise<AskOutcome> {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return { kind: 'choice', choice: { kind: 'inherit' } }
  try {
    const menu = buildMenu(routes.slice(0, MODEL_MENU_LIMIT))
    const ask = userQuestions.ask({
      questions: [
        {
          id: 'model',
          header: 'Handoff',
          question: '新会话使用哪个模型？',
          options: [
            { label: LABEL_INHERIT, description: routeText(LABEL_INHERIT, inherited) },
            { label: LABEL_DEFAULT, description: routeText(LABEL_DEFAULT, fallback) },
            ...menu.map((entry) => ({ label: entry.label, description: menuDescription(entry.route) })),
          ],
        },
      ],
      agent,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS)
    })
    let answer: Awaited<typeof ask> | 'timeout'
    try {
      answer = await Promise.race([ask, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (answer === 'timeout') return { kind: 'choice', choice: { kind: 'inherit' } }
    const item = answer.answers[0]
    const selected = item?.selected[0]
    if (selected === LABEL_DEFAULT) return { kind: 'choice', choice: { kind: 'default' } }
    if (selected !== undefined && selected !== LABEL_INHERIT) {
      const picked = menu.find((entry) => entry.label === selected)
      if (picked !== undefined) {
        return {
          kind: 'choice',
          choice: { kind: 'model', provider: picked.route.provider, model: picked.route.model },
        }
      }
    }
    const custom = item?.custom?.trim()
    if (selected === undefined && custom !== undefined && custom.length > 0) {
      const route = parseModelSpec(custom, routes)
      if (route === undefined) {
        return { kind: 'cancel', reason: `无法解析模型 "${custom}"（写模型名或 provider/model，也可从列表里点选）` }
      }
      return { kind: 'choice', choice: { kind: 'model', provider: route.provider, model: route.model } }
    }
    return { kind: 'choice', choice: { kind: 'inherit' } }
  } catch {
    // Dismissed card, aborted request, or an answerer failure: treat as cancel.
    return { kind: 'cancel' }
  }
}

/** One line naming the route a base option resolves to, effort included. */
function routeText(label: string, summary: RouteSummary | undefined): string {
  if (summary === undefined) {
    return label === LABEL_DEFAULT ? '默认 preset + 全局默认模型' : '沿用本会话的 preset 与模型'
  }
  const effort = summary.reasoningEffort === undefined ? '' : ` · 强度 ${summary.reasoningEffort}`
  return `${summary.provider}/${summary.model}${effort}${label === LABEL_DEFAULT ? '（全局默认）' : '（本会话）'}`
}

/**
 * Resolve the fresh session's model: prefer the browser picker (a searchable,
 * provider-grouped dropdown backed by the same catalog as the /model popup),
 * and fall back to the shipped question card whenever no browser is attached
 * or the picker goes unanswered.
 */
async function resolveChoice(rt: HandoffRuntime, agent: Agent, task: string): Promise<AskOutcome> {
  const { ctx, config } = rt
  const inherited = sessionRoute(ctx, agent)
  const fallback = defaultRoute(ctx)
  const channel = rt.channel
  if (channel !== undefined && channel.clientAttached()) {
    const outcome = await channel.request(
      {
        sessionId: String(agent.id),
        task,
        ...(inherited === undefined ? {} : { inherited }),
        ...(fallback === undefined ? {} : { fallback }),
      },
      rt.pickTimeoutMs,
    )
    if (outcome !== undefined) return outcome
    ctx.logger(PACKAGE_NAME).warn('model picker unanswered; inheriting the origin model')
    return { kind: 'choice', choice: { kind: 'inherit' } }
  }
  const routes = config.modelMenu !== false ? await listModelRoutes(ctx) : []
  return askChoiceCard(ctx, agent, routes, inherited, fallback)
}

/** Human-readable name of a resolved choice for the command result. */
function describeChoice(
  choice: ModelChoice,
  inherited: RouteSummary | undefined,
  fallback: RouteSummary | undefined,
): string {
  const named = (label: string, route: RouteSummary | undefined): string => {
    if (route === undefined) return label
    const effort = route.reasoningEffort === undefined ? '' : ` · 强度 ${route.reasoningEffort}`
    return `${label}（${route.provider}/${route.model}${effort}）`
  }
  if (choice.kind === 'model') {
    const route = `${choice.provider}/${choice.model}`
    return choice.reasoningEffort === undefined ? route : `${route}（强度 ${choice.reasoningEffort}）`
  }
  return choice.kind === 'default' ? named(LABEL_DEFAULT, fallback) : named(LABEL_INHERIT, inherited)
}

/** Build the `/handoff` command definition. */
export function handoffCommandDefinition(rt: HandoffRuntime): CommandDefinition {
  const { ctx, config } = rt
  return {
    name: COMMAND_NAME,
    description: 'summarize this session into a self-contained brief, then start a fresh session on the task',
    input: { hint: '[--model provider/model] <task description>' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const agent = invocation.agent
      let task = invocation.rawInput.trim()

      // `/handoff --model provider/model <task>`: explicit route, no dialog.
      let flagChoice: ModelChoice | undefined
      if (task.startsWith(`${MODEL_FLAG} `)) {
        const rest = task.slice(MODEL_FLAG.length + 1).trim()
        const space = rest.indexOf(' ')
        const spec = space === -1 ? rest : rest.slice(0, space)
        const route = parseModelFlagValue(spec)
        if (route === undefined || space === -1) {
          return fail(`Usage: /handoff ${MODEL_FLAG} provider/model <task description>`)
        }
        flagChoice = { kind: 'model', provider: route.provider, model: route.model }
        task = rest.slice(space + 1).trim()
      }
      if (task.length === 0) {
        return fail(`Usage: /handoff [${MODEL_FLAG} provider/model] <task description>`)
      }

      const key = keyOf(agent)
      if (rt.pending.has(key)) {
        return fail('A handoff is already in flight for this session; wait for it to finish first.')
      }

      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        return fail('This session records no working directory, so a handoff target workspace is unknown.')
      }

      let choice: ModelChoice
      if (flagChoice !== undefined) {
        choice = flagChoice
      } else if (config.confirm !== false) {
        const outcome = await resolveChoice(rt, agent, task)
        if (outcome.kind === 'cancel') {
          return outcome.reason === undefined ? ok('Handoff cancelled.') : fail(outcome.reason)
        }
        choice = outcome.choice
      } else {
        choice = { kind: 'inherit' }
      }
      const choiceText = describeChoice(choice, sessionRoute(ctx, agent), defaultRoute(ctx))

      const workspace = cwd.replace(/\/+$/, '')
      const dir = config.dir?.startsWith('/') === true
        ? config.dir.replace(/\/+$/, '')
        : `${workspace}/${config.dir ?? DEFAULT_BRIEF_DIR}`
      const briefPath = `${dir}/${timestampSlug(new Date())}-handoff.md`

      // Queue the briefing turn on the CURRENT agent. followup parks a normal
      // next-turn message, so a busy agent writes the brief after its current
      // turn finishes.
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: briefInstruction(briefPath, task, rt.maxBriefChars) }],
          source: { kind: 'user' },
        }),
      )

      const pending: PendingHandoff = {
        agent,
        cwd,
        briefPath,
        task,
        choice,
        startedAt: Date.now(),
        stop: () => {},
      }
      rt.pending.set(key, pending)
      startHandoffWatch(rt, pending)

      ctx.logger(PACKAGE_NAME).info('handoff requested', { session: key, briefPath, choice: choiceText })
      return ok(
        [
          'Handoff started.',
          `- Brief target: \`${briefPath}\``,
          `- Model: ${choiceText}`,
          `The new session appears in this workspace's sidebar (title "Handoff: …") once the brief is complete (timeout ${Math.round(rt.timeoutMs / 1000)}s).`,
        ].join('\n'),
      )
    },
  }
}
