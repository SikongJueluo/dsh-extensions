/**
 * `/handoff` command registration: model-choice dialog plus the briefing
 * instruction handed to the current agent.
 *
 * @module dsh-handoff/command
 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { spawnHandoff } from './spawn.js'
import { COMMAND_NAME, COMPLETE_MARKER, DEFAULT_BRIEF_DIR, PACKAGE_NAME } from './identity.js'
import { briefInstruction, continueInstruction, startHandoffWatch, timestampSlug } from './brief.js'
import type { ModelChoice, PresetChoice } from './choice.js'
import type { HandoffRuntime, PendingHandoff } from './pending.js'
import { findLatestUnspawned, metaPathFor, writeMeta, type RecoveredHandoff } from './meta.js'
import type { ReviewPick, WorkspacePick, WorkspaceWire } from './channel.js'
import {
  consumeTitleSpec,
  resolveFlagTarget,
  resolveTargetById,
  snapshotRoster,
  targetForOrigin,
  type HandoffTarget,
  type WorkspaceRoster,
} from './workspace.js'
import {
  defaultRoute,
  loadModelCatalog,
  modelChoiceIssue,
  sessionRoute,
  type CatalogSnapshot,
  type RouteSummary,
} from './selection.js'
import { presetName, presetProblem, snapshotPresets, type PresetRoster } from './presets.js'

/** Label shown for "keep this session's preset and model". */
const LABEL_INHERIT = '继承当前会话'
/** Label shown for "same as manually clicking New Session". */
const LABEL_DEFAULT = '全局默认'
/** Label shown for the origin workspace entry of the workspace step. */
const LABEL_ORIGIN = '原工作区'
/** Label for the remembered/retry route offered first on the fallback card. */
const LABEL_LAST = '上次使用的模型'

/** How long the confirmation card may sit unanswered before we fall back to the default choice. */
const CONFIRM_TIMEOUT_MS = 60_000
/** Keep the dialog list sane; beyond this, custom input is the escape hatch. */
const MODEL_MENU_LIMIT = 50
/** Same cap for the workspace question card (the browser list itself is unbounded). */
const WORKSPACE_MENU_LIMIT = 50
/** Prefix flag selecting the fresh session's model without a dialog. */
const MODEL_FLAG = '--model'
/** Prefix flag selecting the target workspace without a dialog. */
const WORKSPACE_FLAG = '--workspace'
/** Bare flag resuming the newest unfinished handoff; same as empty input. */
const RETRY_FLAG = '--retry'
/** Bare flag binding an auto-review loop (dsh-triggers) to the handoff. */
const REVIEW_FLAG = '--review'
/** Prefix flag setting the auto-review round budget; implies --review. */
const REVIEW_ROUNDS_FLAG = '--review-rounds'
/** Round budget offered by default when the user just ticks the toggle. */
const DEFAULT_REVIEW_ROUNDS = 5

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
  return routes.map((route) => ({
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
    return routes.find(
      (route) => route.provider === explicit.provider && route.model === explicit.model,
    )
  }
  const byId = routes.filter((route) => route.model === spec)
  if (byId.length === 1) return byId[0]
  const byName = routes.filter((route) => route.name === spec)
  return byName.length === 1 ? byName[0] : undefined
}

/**
 * Menu rows from a bounded catalog snapshot: the same route metadata the Web
 * /model popup shows, so the fallback card and the browser card agree.
 */
function modelRoutes(catalog: CatalogSnapshot | undefined): ModelRoute[] {
  if (catalog === undefined) return []
  return catalog.models.map((model) => ({
    provider: model.provider,
    providerName: model.providerName,
    model: model.model,
    name: model.name,
  }))
}

/**
 * Dialog outcome: a resolved choice plus its workspace/preset verdicts, or a
 * cancellation. `confirmedModel` is true only when a human explicitly answered
 * the model question; a timeout or a missing answerer settles the default but
 * must never be remembered as a preference.
 */
type AskOutcome =
  | {
      kind: 'choice'
      choice: ModelChoice
      workspace: WorkspacePick
      preset?: PresetChoice
      review?: ReviewPick
      confirmedModel: boolean
    }
  | { kind: 'cancel'; reason?: string }

/** Retry defaults recovered from a previous attempt's sidecar meta. */
interface PreviousDefaults {
  readonly workspaceId?: WorkspacePick
}

/**
 * Host-resolved defaults for one handoff, independent of how the pick is
 * collected: the retry's record beats the remembered preference, which beats
 * first-time inheritance. Issues mark a default that must not run as-is.
 */
interface ChoiceDefaults {
  readonly choice: ModelChoice
  readonly choiceIssue?: string
  readonly preset: PresetChoice
  readonly presetIssue?: string
}

/** The model card's own outcome (the workspace/preset verdicts are asked separately). */
type ModelAskOutcome =
  | { kind: 'choice'; choice: ModelChoice; confirmed: boolean }
  | { kind: 'cancel'; reason?: string }

/** The preset card's outcome, used only when the inherited/default preset is unusable. */
type PresetAskOutcome =
  | { kind: 'choice'; preset: PresetChoice }
  | { kind: 'cancel'; reason?: string }

/** Resolve a workspace verdict (browser pick or card pick) into a spawn target. */
async function resolvePick(
  ctx: Context,
  roster: WorkspaceRoster,
  pick: WorkspacePick,
): Promise<HandoffTarget | { error: string }> {
  if (pick === 'origin') return targetForOrigin(roster)
  const target = await resolveTargetById(ctx, pick)
  return target ?? { error: `所选工作区已不在注册表中（${pick}），请重试 /handoff` }
}

/** Distinguishing suffix for duplicated workspace titles: the final path segments. */
function pathTail(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments.slice(-2).join('/')
}

/** Clickable workspace rows; duplicate titles get the path tail appended. */
function buildWorkspaceMenu(
  rows: readonly { id: string; title: string; path: string }[],
): { label: string; id: string }[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.title, (counts.get(row.title) ?? 0) + 1)
  return rows.map((row) => ({
    label: (counts.get(row.title) ?? 0) > 1 ? `${row.title} (${pathTail(row.path)})` : row.title,
    id: row.id,
  }))
}

/**
 * The workspace half of the shipped question-card path, asked after the model
 * card whenever a browser picker is unavailable. Falls back to the origin on
 * timeout, exactly like the model card falls back to inheritance.
 */
async function askWorkspaceCard(
  ctx: Context,
  agent: Agent,
  roster: WorkspaceRoster,
): Promise<{ kind: 'pick'; pick: WorkspacePick } | { kind: 'cancel'; reason?: string }> {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return { kind: 'pick', pick: 'origin' }
  try {
    const selectable = roster.others.filter((row) => !row.missing)
    const menu = buildWorkspaceMenu(selectable.slice(0, WORKSPACE_MENU_LIMIT))
    const ask = userQuestions.ask({
      questions: [
        {
          id: 'workspace',
          header: 'Handoff',
          question: '新会话开在哪个工作区？',
          options: [
            { label: LABEL_ORIGIN, description: roster.origin.path },
            ...menu.map((entry) => ({
              label: entry.label,
              description: selectable.find((row) => row.id === entry.id)?.path,
            })),
          ],
        },
      ],
      agent,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS)
    })
    let answer: Awaited<typeof ask> | 'timeout'
    try {
      answer = await Promise.race([ask, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (answer === 'timeout') return { kind: 'pick', pick: 'origin' }
    const item = answer.answers[0]
    const selected = item?.selected[0]
    if (selected === LABEL_ORIGIN) return { kind: 'pick', pick: 'origin' }
    if (selected !== undefined) {
      const picked = menu.find((entry) => entry.label === selected)
      if (picked !== undefined) return { kind: 'pick', pick: picked.id }
    }
    const custom = item?.custom?.trim()
    if (selected === undefined && custom !== undefined && custom.length > 0) {
      const resolved = await resolveFlagTarget(ctx, custom)
      if ('error' in resolved)
        return { kind: 'cancel', reason: `无法解析工作区：${resolved.error}` }
      return {
        kind: 'pick',
        pick:
          resolved.target.workspaceId === roster.origin.id
            ? 'origin'
            : (resolved.target.workspaceId ?? 'origin'),
      }
    }
    return { kind: 'pick', pick: 'origin' }
  } catch {
    // Dismissed card, aborted request, or an answerer failure: treat as cancel.
    return { kind: 'cancel' }
  }
}

/**
 * The shipped question-card path: a flat clickable list of model display names
 * plus two base options, and a typed spelling as the escape hatch. Used by
 * deployments with no browser half (TUI/headless).
 *
 * A usable remembered route (or retry pick) is offered as the first row; an
 * unusable one is named in `detail` and never offered, so the card is the
 * reselection affordance instead of a silent fallback.
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
  defaultChoice: ModelChoice,
  defaultIssue: string | undefined,
): Promise<ModelAskOutcome> {
  // An unusable remembered route must never be replaced by a silent guess:
  // without an answer the command fails with the reselect reason instead. A
  // healthy default may proceed, but it is NOT an explicit confirmation.
  const settle = (): ModelAskOutcome =>
    defaultIssue === undefined
      ? { kind: 'choice', choice: defaultChoice, confirmed: false }
      : { kind: 'cancel', reason: defaultIssue }
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return settle()
  try {
    const preferred =
      defaultChoice.kind === 'model' && defaultIssue === undefined ? defaultChoice : undefined
    const menu = buildMenu(
      routes
        .filter(
          (route) =>
            preferred === undefined ||
            route.provider !== preferred.provider ||
            route.model !== preferred.model,
        )
        .slice(0, MODEL_MENU_LIMIT),
    )
    const options = [
      ...(preferred === undefined
        ? []
        : [
            {
              label: LABEL_LAST,
              description: `${preferred.provider}/${preferred.model}${preferred.reasoningEffort === undefined ? '' : ` · 强度 ${preferred.reasoningEffort}`} · 上次交接使用`,
            },
          ]),
      { label: LABEL_INHERIT, description: routeText(LABEL_INHERIT, inherited) },
      { label: LABEL_DEFAULT, description: routeText(LABEL_DEFAULT, fallback) },
      ...menu.map((entry) => ({ label: entry.label, description: menuDescription(entry.route) })),
    ]
    const ask = userQuestions.ask({
      questions: [
        {
          id: 'model',
          header: 'Handoff',
          question: '新会话使用哪个模型？',
          ...(defaultIssue === undefined ? {} : { detail: `${defaultIssue}；请重新选择。` }),
          options,
        },
      ],
      agent,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS)
    })
    let answer: Awaited<typeof ask> | 'timeout'
    try {
      answer = await Promise.race([ask, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (answer === 'timeout') return settle()
    const item = answer.answers[0]
    const selected = item?.selected[0]
    if (selected === LABEL_LAST) return { kind: 'choice', choice: defaultChoice, confirmed: true }
    if (selected === LABEL_DEFAULT)
      return { kind: 'choice', choice: { kind: 'default' }, confirmed: true }
    if (selected !== undefined && selected !== LABEL_INHERIT) {
      const picked = menu.find((entry) => entry.label === selected)
      if (picked !== undefined) {
        return {
          kind: 'choice',
          choice: { kind: 'model', provider: picked.route.provider, model: picked.route.model },
          confirmed: true,
        }
      }
    }
    const custom = item?.custom?.trim()
    if (selected === undefined && custom !== undefined && custom.length > 0) {
      const route = parseModelSpec(custom, routes)
      if (route === undefined) {
        return {
          kind: 'cancel',
          reason: `无法解析模型 "${custom}"（写模型名或 provider/model，也可从列表里点选）`,
        }
      }
      return {
        kind: 'choice',
        choice: { kind: 'model', provider: route.provider, model: route.model },
        confirmed: true,
      }
    }
    if (selected === LABEL_INHERIT)
      return { kind: 'choice', choice: { kind: 'inherit' }, confirmed: true }
    return settle()
  } catch {
    // Dismissed card, aborted request, or an answerer failure: treat as cancel.
    return { kind: 'cancel' }
  }
}

/**
 * Ask for a preset only when the resolved default cannot be mounted (the
 * origin's preset was deleted or is broken). A healthy default never adds a
 * step; without usable rows the handoff fails with the reason instead of
 * composing a preset-less session.
 */
async function askPresetCard(
  ctx: Context,
  agent: Agent,
  roster: PresetRoster,
  issue: string,
): Promise<PresetAskOutcome> {
  const usable = roster.options.filter((option) => option.broken === undefined)
  if (usable.length === 0) return { kind: 'cancel', reason: `${issue}；当前没有其他可用的预设` }
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined)
    return { kind: 'cancel', reason: `${issue}；请在配置卡中重新选择预设` }
  try {
    const menu = usable.slice(0, WORKSPACE_MENU_LIMIT)
    // Names need not be unique; a label shared by several rows gets its id
    // appended so a click always maps back to exactly one preset.
    const counts = new Map<string, number>()
    for (const option of menu) {
      const label = option.name ?? option.id
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const labelFor = (option: PresetRoster['options'][number]): string => {
      const base = option.name ?? option.id
      return (counts.get(base) ?? 0) > 1 ? `${base} (${option.id})` : base
    }
    const ask = userQuestions.ask({
      questions: [
        {
          id: 'preset',
          header: 'Handoff',
          question: '新会话使用哪个预设？',
          detail: issue,
          options: menu.map((option) => ({
            label: labelFor(option),
            description: option.description ?? option.id,
          })),
        },
      ],
      agent,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS)
    })
    let answer: Awaited<typeof ask> | 'timeout'
    try {
      answer = await Promise.race([ask, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (answer === 'timeout') return { kind: 'cancel', reason: issue }
    const selected = answer.answers[0]?.selected[0]
    const picked = menu.find((option) => labelFor(option) === selected)
    if (picked === undefined) return { kind: 'cancel', reason: issue }
    return { kind: 'choice', preset: { kind: 'preset', id: picked.id } }
  } catch {
    return { kind: 'cancel', reason: issue }
  }
}

/** One line naming the route a base option resolves to, effort included. */
function routeText(label: string, summary: RouteSummary | undefined): string {
  if (summary === undefined) {
    return label === LABEL_DEFAULT ? '部署默认模型' : '沿用本会话的模型与强度'
  }
  const effort = summary.reasoningEffort === undefined ? '' : ` · 强度 ${summary.reasoningEffort}`
  return `${summary.provider}/${summary.model}${effort}${label === LABEL_DEFAULT ? '（全局默认）' : '（本会话）'}`
}

/** The shipped review question of the card path: off unless the user opts in. */
async function askReviewCard(
  ctx: Context,
  agent: Agent,
  defaultRounds: number,
): Promise<{ enabled: boolean; rounds: number }> {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return { enabled: false, rounds: defaultRounds }
  try {
    const ask = userQuestions.ask({
      questions: [
        {
          id: 'review',
          header: 'Handoff',
          question: `执行完成后自动交回当前会话审核？（最多 ${defaultRounds} 轮）`,
          options: [
            {
              label: '开启自动审核',
              description: `交付后自动送审，返工意见自动发回执行会话，最多 ${defaultRounds} 轮`,
            },
            { label: '关闭', description: '普通交接，行为与从前一致' },
          ],
        },
      ],
      agent,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS)
    })
    let answer: Awaited<typeof ask> | 'timeout'
    try {
      answer = await Promise.race([ask, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (answer === 'timeout') return { enabled: false, rounds: defaultRounds }
    const selected = answer.answers[0]?.selected[0]
    return { enabled: selected === '开启自动审核', rounds: defaultRounds }
  } catch {
    // Dismissed card or answerer failure: plain handoff.
    return { enabled: false, rounds: defaultRounds }
  }
}

/**
 * The review block on the wire: `fixed` marks a flag-decided verdict shown
 * read-only (the summary must never contradict the flags), otherwise it is
 * the offered toggle the card or a fallback card asks about.
 */
type ReviewWire = { defaultRounds: number; enabled?: boolean; fixed?: boolean }

/**
 * Resolve the fresh session's model and workspace: prefer the browser card
 * (defaults pre-filled, per-field 更改 buttons, one 开始交接 submit) and fall
 * back to the shipped question cards whenever no browser is attached or the
 * card goes unanswered.
 *
 * `modelFixed` means the model came from `--model` (with `fixedRoute` naming
 * that route for the summary) and `fixedWorkspace` names the `--workspace`
 * flag's target; fixed fields render read-only and the returned choice is a
 * placeholder the caller overrides with the flag's route/target.
 *
 * `previous` (retries only) forwards the last attempt's picks so the card can
 * pre-fill them; the card fallback path ignores it.
 *
 * `reviewWire` (present = dsh-triggers mounted, or `--review` already
 * decided) must stay reachable on EVERY path unless fixed: it becomes the
 * card's review block or one extra card — never something a fixed flag
 * silently skips.
 */
/** Everything one pick needs; the collector differs per path, the defaults do not. */
interface ResolveChoiceInput {
  readonly rt: HandoffRuntime
  readonly agent: Agent
  readonly task: string
  readonly roster: WorkspaceRoster
  readonly needWorkspace: boolean
  readonly modelFixed: boolean
  readonly defaults: ChoiceDefaults
  readonly presets?: PresetRoster
  readonly catalog?: CatalogSnapshot
  readonly previous?: PreviousDefaults
  readonly reviewWire?: ReviewWire
  readonly fixedRoute?: RouteSummary
  readonly fixedWorkspace?: WorkspaceWire
}

async function resolveChoice(input: ResolveChoiceInput): Promise<AskOutcome> {
  const {
    rt,
    agent,
    task,
    roster,
    needWorkspace,
    modelFixed,
    defaults,
    presets,
    catalog,
    previous,
    reviewWire,
    fixedRoute,
    fixedWorkspace,
  } = input
  const reviewAsk = reviewWire !== undefined && reviewWire.fixed !== true
  const { ctx, config } = rt
  const inherited = sessionRoute(agent)
  const fallback = defaultRoute(ctx)
  const channel = rt.channel

  /**
   * Finish a card-path pick: ask for a preset only when the resolved default
   * cannot mount, then return the one verdict the caller persists.
   */
  const finish = async (
    choice: ModelChoice,
    workspace: WorkspacePick,
    review: ReviewPick | undefined,
    confirmedModel: boolean,
  ): Promise<AskOutcome> => {
    let preset = defaults.preset
    if (defaults.presetIssue !== undefined) {
      if (presets === undefined) return { kind: 'cancel', reason: defaults.presetIssue }
      const verdict = await askPresetCard(ctx, agent, presets, defaults.presetIssue)
      if (verdict.kind === 'cancel') return verdict
      preset = verdict.preset
    }
    return {
      kind: 'choice',
      choice,
      workspace,
      preset,
      ...(review !== undefined && review.enabled ? { review } : {}),
      confirmedModel,
    }
  }

  if (channel !== undefined && channel.clientAttached()) {
    const outcome = await channel.request(
      {
        sessionId: String(agent.id),
        task,
        ...(inherited === undefined ? {} : { inherited }),
        ...(fallback === undefined ? {} : { fallback }),
        defaultChoice: defaults.choice,
        ...(defaults.choiceIssue === undefined ? {} : { defaultChoiceIssue: defaults.choiceIssue }),
        ...(presets === undefined
          ? {}
          : {
              preset: {
                ...(presets.inherited === undefined ? {} : { inherited: presets.inherited }),
                options: presets.options,
                default: defaults.preset,
                ...(defaults.presetIssue === undefined
                  ? {}
                  : { defaultIssue: defaults.presetIssue }),
              },
            }),
        ...(needWorkspace
          ? {
              origin: roster.origin,
              workspaces: roster.others,
              pickWorkspace: true,
            }
          : {}),
        ...(modelFixed
          ? {
              modelFixed: true,
              ...(fixedRoute !== undefined
                ? {
                    fixedModel: {
                      provider: fixedRoute.provider,
                      model: fixedRoute.model,
                      ...(fixedRoute.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: fixedRoute.reasoningEffort }),
                    },
                  }
                : {}),
            }
          : {}),
        ...(fixedWorkspace !== undefined ? { fixedWorkspace } : {}),
        ...(previous?.workspaceId === undefined
          ? {}
          : { previous: { workspaceId: previous.workspaceId } }),
        ...(reviewWire === undefined ? {} : { review: reviewWire }),
      },
      rt.pickTimeoutMs,
    )
    if (outcome !== undefined) {
      if (outcome.kind === 'cancel') return { kind: 'cancel' }
      // A submitted card is an explicit human answer, even when it accepts a
      // preselected default: that is what may become the remembered choice.
      return {
        kind: 'choice',
        choice: outcome.choice,
        workspace: outcome.workspace,
        ...(outcome.preset === undefined ? {} : { preset: outcome.preset }),
        ...(outcome.review === undefined ? {} : { review: outcome.review }),
        confirmedModel: true,
      }
    }
    // The card never answered. A known-unusable route or preset must not be
    // replaced silently (least of all by the origin's expensive model): fail
    // with the reselect reason; a healthy default stands but is not confirmed.
    if (defaults.presetIssue !== undefined) return { kind: 'cancel', reason: defaults.presetIssue }
    if (defaults.choiceIssue !== undefined) return { kind: 'cancel', reason: defaults.choiceIssue }
    ctx.logger(PACKAGE_NAME).warn('model picker unanswered; using the resolved default')
    return {
      kind: 'choice',
      choice: defaults.choice,
      workspace: 'origin',
      preset: defaults.preset,
      confirmedModel: false,
    }
  }

  if (!modelFixed) {
    const routes = config.modelMenu !== false ? modelRoutes(catalog) : []
    const model = await askChoiceCard(
      ctx,
      agent,
      routes,
      inherited,
      fallback,
      defaults.choice,
      defaults.choiceIssue,
    )
    if (model.kind === 'cancel') return model
    if (!needWorkspace) {
      const review = reviewAsk
        ? await askReviewCard(ctx, agent, reviewWire.defaultRounds)
        : undefined
      return finish(
        model.choice,
        'origin',
        review?.enabled === true ? review : undefined,
        model.confirmed,
      )
    }
    const workspace = await askWorkspaceCard(ctx, agent, roster)
    if (workspace.kind === 'cancel') return workspace
    const review = reviewAsk ? await askReviewCard(ctx, agent, reviewWire.defaultRounds) : undefined
    return finish(
      model.choice,
      workspace.pick,
      review?.enabled === true ? review : undefined,
      model.confirmed,
    )
  }

  // --model given: no model card. The review and preset verdicts still must
  // be asked when they are open.
  const baseChoice: ModelChoice = { kind: 'inherit' }
  if (!needWorkspace) {
    const review = reviewAsk ? await askReviewCard(ctx, agent, reviewWire.defaultRounds) : undefined
    return finish(baseChoice, 'origin', review?.enabled === true ? review : undefined, false)
  }
  const workspace = await askWorkspaceCard(ctx, agent, roster)
  if (workspace.kind === 'cancel') return workspace
  const review = reviewAsk ? await askReviewCard(ctx, agent, reviewWire.defaultRounds) : undefined
  return finish(baseChoice, workspace.pick, review?.enabled === true ? review : undefined, false)
}

/** One picker row's display name, falling back to the bare route. */
function named(label: string, route: RouteSummary | undefined): string {
  if (route === undefined) return label
  const effort = route.reasoningEffort === undefined ? '' : ` · 强度 ${route.reasoningEffort}`
  return `${label}（${route.provider}/${route.model}${effort}）`
}

/** Human-readable name of a resolved choice for the command result. */
function describeChoice(
  choice: ModelChoice,
  inherited: RouteSummary | undefined,
  fallback: RouteSummary | undefined,
): string {
  if (choice.kind === 'model') {
    const route = `${choice.provider}/${choice.model}`
    return choice.reasoningEffort === undefined
      ? route
      : `${route}（强度 ${choice.reasoningEffort}）`
  }
  return choice.kind === 'default'
    ? named(LABEL_DEFAULT, fallback)
    : named(LABEL_INHERIT, inherited)
}

/** Human-readable preset verdict for the command result. */
function describePreset(presets: PresetRoster, preset: PresetChoice): string {
  if (preset.kind === 'preset') return presetName(presets, preset.id)
  return presets.inherited === undefined
    ? '继承当前（无预设）'
    : `继承当前（${presetName(presets, presets.inherited)}）`
}

/** Build the `/handoff` command definition. */
export function handoffCommandDefinition(rt: HandoffRuntime): CommandDefinition {
  const { ctx, config } = rt
  return {
    name: COMMAND_NAME,
    description:
      'summarize this session into a self-contained brief, then start a fresh session on the task; a bare /handoff retries the last unfinished handoff',
    input: {
      hint: '[--model provider/model] [--workspace <title|path>] [--retry] [--review] [--review-rounds <n>] <task description>',
    },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const agent = invocation.agent
      let task = invocation.rawInput.trim()
      const usage = `Usage: /handoff [${MODEL_FLAG} provider/model] [${WORKSPACE_FLAG} <title|path>] [${RETRY_FLAG}] [${REVIEW_FLAG}] [${REVIEW_ROUNDS_FLAG} <n>] <task description>`

      // Leading flags (`--model provider/model`, `--workspace <title|path>`)
      // skip their dialog step; flags may appear in either order. A workspace
      // title may contain spaces, so `--workspace` first tries the longest
      // registered-title prefix before falling back to a single token (path).
      // `--review` takes no value and binds the auto-review loop;
      // `--review-rounds <n>` sets its budget and implies `--review`.
      // `--retry` takes no value and resumes the newest unfinished handoff.
      let flagChoice: ModelChoice | undefined
      let flagWorkspaceSpec: string | undefined
      let retryFlag = false
      let reviewFlag = false
      let reviewRoundsFlag: number | undefined
      for (;;) {
        if (task === RETRY_FLAG) {
          retryFlag = true
          task = ''
          break
        }
        if (task.startsWith(`${RETRY_FLAG} `)) {
          retryFlag = true
          task = task.slice(RETRY_FLAG.length + 1).trim()
          continue
        }
        if (task === REVIEW_FLAG) {
          reviewFlag = true
          task = ''
          break
        }
        if (task.startsWith(`${REVIEW_FLAG} `)) {
          reviewFlag = true
          task = task.slice(REVIEW_FLAG.length + 1).trim()
          continue
        }
        if (task.startsWith(`${REVIEW_ROUNDS_FLAG} `)) {
          const rest = task.slice(REVIEW_ROUNDS_FLAG.length + 1).trim()
          const space = rest.indexOf(' ')
          const token = space === -1 ? rest : rest.slice(0, space)
          // `Number` over `Number.parseInt`: the token is the first space-delimited
          // slice of the flag argument, so it is a plain integer on every reachable
          // input; a garbage token must fail the usage check, not parse as a prefix.
          const rounds = Number(token)
          if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) return fail(usage)
          reviewFlag = true
          reviewRoundsFlag = rounds
          task = space === -1 ? '' : rest.slice(space + 1).trim()
          continue
        }
        const flag = task.startsWith(`${MODEL_FLAG} `)
          ? MODEL_FLAG
          : task.startsWith(`${WORKSPACE_FLAG} `)
            ? WORKSPACE_FLAG
            : undefined
        if (flag === undefined) break
        const rest = task.slice(flag.length + 1).trim()
        if (flag === WORKSPACE_FLAG) {
          const titled = consumeTitleSpec(ctx, rest)
          if (titled !== undefined) {
            flagWorkspaceSpec = titled.spec
            task = titled.remaining
            continue
          }
        }
        const space = rest.indexOf(' ')
        if (space === -1) return fail(usage)
        const spec = rest.slice(0, space)
        if (flag === MODEL_FLAG) {
          const route = parseModelFlagValue(spec)
          if (route === undefined) return fail(usage)
          flagChoice = { kind: 'model', provider: route.provider, model: route.model }
        } else if (spec.length === 0) {
          return fail(usage)
        } else {
          flagWorkspaceSpec = spec
        }
        task = rest.slice(space + 1).trim()
      }
      if (retryFlag && task.length > 0) {
        return fail(
          `${RETRY_FLAG} 与任务描述互斥：重试上一次交接时不写任务（沿用原任务），发起新交接时才写任务描述。\n${usage}`,
        )
      }
      // A bare /handoff (empty input) is the retry entry.
      const retry = retryFlag || task.length === 0

      const key = keyOf(agent)
      if (rt.pending.has(key)) {
        return fail('A handoff is already in flight for this session; wait for it to finish first.')
      }

      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        return fail(
          'This session records no working directory, so a handoff target workspace is unknown.',
        )
      }

      // Resolve the flag's workspace (if any) before opening any dialog, so
      // the picker knows the target is settled and skips its workspace step.
      let flagTarget: HandoffTarget | undefined
      if (flagWorkspaceSpec !== undefined) {
        const resolved = await resolveFlagTarget(ctx, flagWorkspaceSpec)
        if ('error' in resolved) return fail(resolved.error)
        flagTarget = resolved.target
      }

      const roster = await snapshotRoster(ctx, cwd)
      const needWorkspace = flagTarget === undefined && roster.others.some((row) => !row.missing)

      const workspace = cwd.replace(/\/+$/u, '')
      const dir =
        config.dir?.startsWith('/') === true
          ? config.dir.replace(/\/+$/u, '')
          : `${workspace}/${config.dir ?? DEFAULT_BRIEF_DIR}`

      // --- retry recovery -------------------------------------------------
      // The sidecar meta is the only state that survives a timeout, a dsh
      // restart, or a spawn crash: the newest record without `spawnedAt` is
      // the handoff a bare /handoff resumes.
      let recovered: RecoveredHandoff | undefined
      if (retry) {
        recovered = await findLatestUnspawned(dir)
        if (recovered === undefined) {
          return fail(
            `没有可重试的交接：${dir} 里没有未完成的记录。发起新交接请写 /handoff <任务描述>。`,
          )
        }
      }
      let existingBrief: string | undefined
      if (recovered !== undefined) {
        try {
          existingBrief = await readFile(recovered.briefPath, 'utf8')
        } catch {
          // Never written: the retry re-issues the full briefing instruction.
        }
      }

      const briefPath = recovered?.briefPath ?? `${dir}/${timestampSlug(new Date())}-handoff.md`
      const metaPath = metaPathFor(briefPath)
      const taskText = recovered?.meta.task ?? task
      const originSession = recovered?.meta.originSession ?? key
      const createdAt = recovered?.meta.createdAt ?? Date.now()
      const previous: PreviousDefaults | undefined =
        recovered === undefined
          ? undefined
          : { workspaceId: recovered.meta.target.workspaceId ?? 'origin' }
      // Priority for the fresh session's model: an explicit --model flag beats
      // the UI answer, which beats this retry's recorded pick, which beats the
      // remembered handoff preference; first-time handoffs inherit. The preset
      // is a separate intent: it defaults to the origin's live preset and is
      // never remembered across normal handoffs.
      const remembered = await rt.preferences?.read()
      const defaultChoice: ModelChoice =
        flagChoice !== undefined
          ? { kind: 'inherit' }
          : (recovered?.meta.choice ?? remembered ?? { kind: 'inherit' })
      const defaultPreset: PresetChoice = recovered?.meta.preset ?? { kind: 'inherit' }
      const presets = await snapshotPresets(ctx, agent)
      const browserAttached = rt.channel !== undefined && rt.channel.clientAttached()
      const wantsRoutes = !browserAttached && flagChoice === undefined && config.modelMenu !== false
      const wantsValidation = flagChoice === undefined && defaultChoice.kind === 'model'
      const catalog = wantsRoutes || wantsValidation ? await loadModelCatalog(ctx) : undefined
      const choiceIssue =
        flagChoice === undefined && catalog !== undefined
          ? modelChoiceIssue(catalog, defaultChoice)
          : undefined
      const presetIssue = presets === undefined ? undefined : presetProblem(presets, defaultPreset)
      const defaults: ChoiceDefaults = {
        choice: defaultChoice,
        ...(choiceIssue === undefined ? {} : { choiceIssue }),
        preset: defaultPreset,
        ...(presetIssue === undefined ? {} : { presetIssue }),
      }
      const notOrigin = String(agent.id) !== originSession

      // A sidecar may carry an explicit preset written where a registry was
      // mounted. Without one this command cannot honor the intent and must not
      // substitute a preset-less session: fail before writing the sidecar, so
      // the retry record (and its preset) survives for a repaired composition.
      if (defaultPreset.kind === 'preset' && presets === undefined) {
        return fail(
          `无法挂载预设 ${defaultPreset.id}：当前组合没有可用的预设注册表（agentPresets 缺失或无法读取）。` +
            '请修复组合后重试；本次交接记录未被标记为已创建。',
        )
      }

      // The wire review block: `fixed` when the flags already decided it (the
      // card then shows the verdict read-only, so the summary never
      // contradicts the flags), otherwise the offered toggle — a retry
      // pre-checks last time's verdict.
      const triggersMounted = ctx.get('triggerBindings') !== undefined
      const reviewWire: ReviewWire | undefined = reviewFlag
        ? { defaultRounds: reviewRoundsFlag ?? DEFAULT_REVIEW_ROUNDS, enabled: true, fixed: true }
        : triggersMounted
          ? {
              defaultRounds: recovered?.meta.review?.maxRounds ?? DEFAULT_REVIEW_ROUNDS,
              ...(recovered?.meta.review !== undefined ? { enabled: true } : {}),
            }
          : undefined
      // The flags' fixed values, for the card's read-only summary rows.
      const fixedRoute: RouteSummary | undefined =
        flagChoice !== undefined && flagChoice.kind === 'model'
          ? {
              provider: flagChoice.provider,
              model: flagChoice.model,
              ...(flagChoice.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: flagChoice.reasoningEffort }),
            }
          : undefined
      const fixedWorkspace: WorkspaceWire | undefined =
        flagTarget === undefined
          ? undefined
          : {
              id: flagTarget.workspaceId ?? 'origin',
              title: flagTarget.title,
              path: flagTarget.path,
              missing: false,
            }

      // A dialog-free path cannot reselect a stale remembered route/preset;
      // refuse with a visible reason instead of spawning something unusable.
      if (config.confirm === false) {
        const stale = flagChoice === undefined ? defaults.choiceIssue : undefined
        if (stale !== undefined) {
          return fail(`${stale}。请用 ${MODEL_FLAG} 指定本次模型，或在配置卡中重新选择。`)
        }
        if (defaults.presetIssue !== undefined) {
          return fail(`${defaults.presetIssue}。请修复或更换预设后再试。`)
        }
      }

      let choice: ModelChoice
      let preset: PresetChoice
      let target: HandoffTarget
      let dialogReview: ReviewPick | undefined
      // Only an explicit human answer to the model question may be remembered;
      // timeouts and the dialog-free paths leave the long-term choice alone.
      let confirmedModel = false
      const taskLabel = retry ? `重试：${taskText}` : taskText
      const reviewOpen = reviewWire !== undefined && reviewWire.fixed !== true
      if (
        flagChoice !== undefined &&
        (flagTarget !== undefined || !needWorkspace) &&
        !reviewOpen &&
        defaults.presetIssue === undefined
      ) {
        // Nothing is left to ask: a scripted invocation must not wait for a
        // card just to confirm fields the flags already decided.
        choice = flagChoice
        target = flagTarget ?? targetForOrigin(roster)
        preset = defaultPreset
      } else if (flagChoice !== undefined && flagTarget !== undefined) {
        choice = flagChoice
        target = flagTarget
        preset = defaultPreset
        // Everything else is flag-decided; the review verdict and a stale
        // preset still must be reachable through the card when one is open.
        const presetAsk = defaults.presetIssue !== undefined
        if (
          ((reviewWire !== undefined && reviewWire.fixed !== true) || presetAsk) &&
          config.confirm !== false
        ) {
          const outcome = await resolveChoice({
            rt,
            agent,
            task: taskLabel,
            roster,
            needWorkspace: false,
            modelFixed: true,
            defaults,
            ...(presets === undefined ? {} : { presets }),
            ...(catalog === undefined ? {} : { catalog }),
            ...(previous === undefined ? {} : { previous }),
            ...(reviewWire === undefined ? {} : { reviewWire }),
            fixedRoute,
            fixedWorkspace,
          })
          if (outcome.kind === 'cancel') {
            return outcome.reason === undefined ? ok('Handoff cancelled.') : fail(outcome.reason)
          }
          if (outcome.review?.enabled === true) dialogReview = outcome.review
          preset = outcome.preset ?? defaultPreset
        }
      } else if (config.confirm !== false) {
        const outcome = await resolveChoice({
          rt,
          agent,
          task: taskLabel,
          roster,
          needWorkspace,
          modelFixed: flagChoice !== undefined,
          defaults,
          ...(presets === undefined ? {} : { presets }),
          ...(catalog === undefined ? {} : { catalog }),
          ...(previous === undefined ? {} : { previous }),
          ...(reviewWire === undefined ? {} : { reviewWire }),
          fixedRoute,
          fixedWorkspace,
        })
        if (outcome.kind === 'cancel') {
          return outcome.reason === undefined ? ok('Handoff cancelled.') : fail(outcome.reason)
        }
        choice = flagChoice ?? outcome.choice
        preset = outcome.preset ?? defaultPreset
        dialogReview = outcome.review
        confirmedModel = outcome.confirmedModel
        const resolved = flagTarget ?? (await resolvePick(ctx, roster, outcome.workspace))
        if ('error' in resolved) return fail(resolved.error)
        target = resolved
      } else if (previous !== undefined) {
        // Dialog-free retry: the previous picks stand in for the defaults.
        choice = flagChoice ?? defaults.choice
        preset = defaultPreset
        if (flagTarget !== undefined) {
          target = flagTarget
        } else if (previous.workspaceId !== undefined && previous.workspaceId !== 'origin') {
          target = (await resolveTargetById(ctx, previous.workspaceId)) ?? targetForOrigin(roster)
        } else {
          target = targetForOrigin(roster)
        }
      } else {
        choice = flagChoice ?? defaults.choice
        preset = defaultPreset
        target = flagTarget ?? targetForOrigin(roster)
      }

      // Last line of defense for the paths that could not ask (a timed-out
      // card, a dialog-free command, a hand-edited sidecar): never spawn on a
      // route or preset the catalog just proved unusable.
      if (flagChoice === undefined && catalog !== undefined) {
        const stale = modelChoiceIssue(catalog, choice)
        if (stale !== undefined) {
          return fail(
            `${stale}。请重新执行 /handoff 并在配置卡中选择模型（或用 ${MODEL_FLAG} 指定本次模型）。`,
          )
        }
      }
      if (presets !== undefined) {
        const stale = presetProblem(presets, preset)
        if (stale !== undefined)
          return fail(`${stale}。请重新执行 /handoff 并在配置卡中重新选择预设。`)
      }

      const crossWorkspace = target.path !== roster.origin.path
      const choiceText = describeChoice(choice, sessionRoute(agent), defaultRoute(ctx))
      const presetText = presets === undefined ? undefined : describePreset(presets, preset)
      // A --model override is a one-off, and a default that no human confirmed
      // (timeout, missing answerer, confirm:false) must not become the
      // remembered choice either.
      const rememberModel = flagChoice === undefined && confirmedModel

      // Final review verdict: flags win, the dialog verdict second, and a
      // dialog-free retry reuses the previous attempt's recorded verdict.
      const previousReview = recovered?.meta.review
      const reviewEnabled =
        reviewFlag ||
        dialogReview?.enabled === true ||
        (config.confirm === false && recovered !== undefined && previousReview !== undefined)
      const review = reviewEnabled
        ? {
            maxRounds: reviewFlag
              ? (reviewRoundsFlag ?? DEFAULT_REVIEW_ROUNDS)
              : (dialogReview?.rounds ?? previousReview?.maxRounds ?? DEFAULT_REVIEW_ROUNDS),
          }
        : undefined

      // The sidecar is the retry contract — task, picks, and the spawn
      // record. A failed write only costs retryability, never the handoff;
      // on a retry it also keeps the record truthful about re-resolved picks.
      try {
        await writeMeta(metaPath, {
          version: 1,
          task: taskText,
          originSession,
          target,
          choice,
          preset,
          createdAt,
          ...(review === undefined ? {} : { review }),
        })
      } catch (error) {
        ctx.logger(PACKAGE_NAME).warn('meta write failed; this handoff will not be retryable', {
          error: String(error),
          metaPath,
        })
      }

      // A brief that already carries the completion marker means the watch
      // was lost (timeout race, dsh restart, spawn crash): no briefing turn,
      // spawn straight from the file.
      if (existingBrief !== undefined && existingBrief.includes(COMPLETE_MARKER)) {
        const pending: PendingHandoff = {
          agent,
          cwd,
          target,
          crossWorkspace,
          briefPath,
          task: taskText,
          originLabel: originSession,
          choice,
          preset,
          rememberModel,
          ...(review === undefined ? {} : { review }),
          startedAt: Date.now(),
          stop: () => {},
        }
        try {
          await spawnHandoff(rt, pending, existingBrief)
        } catch (error) {
          ctx.logger(PACKAGE_NAME).warn('retry spawn failed', { error: String(error), briefPath })
          return fail(
            `重试失败：新会话创建未成功（${String(error)}）。记录未标记，可再次执行 /handoff 重试。`,
          )
        }
        ctx.logger(PACKAGE_NAME).info('handoff resumed; brief already complete', {
          session: key,
          briefPath,
          choice: choiceText,
          target: target.path,
        })
        return ok(
          [
            'Handoff resumed — the brief was already complete, so the fresh session has been spawned.',
            `- Brief: \`${briefPath}\`（发起于 ${new Date(createdAt).toLocaleString('zh-CN')}）`,
            `- Model: ${choiceText}`,
            ...(presetText === undefined ? [] : [`- Preset: ${presetText}`]),
            ...(crossWorkspace ? [`- Target workspace: ${target.title} (\`${target.path}\`)`] : []),
            ...(review === undefined
              ? []
              : [
                  `- Auto review: 已请求（最多 ${review.maxRounds} 轮）——绑定随新会话创建进行，成功后本会话标题栏出现「触发」状态；失败会在此通知并降级普通交接`,
                ]),
          ].join('\n'),
        )
      }

      // Queue the briefing turn on the CURRENT agent. followup parks a normal
      // next-turn message, so a busy agent writes the brief after its current
      // turn finishes. The brief always lands origin-side: that is the one
      // place the origin agent can write under every sandbox mode.
      const instruction =
        existingBrief === undefined
          ? briefInstruction(
              briefPath,
              taskText,
              rt.maxBriefChars,
              crossWorkspace ? { title: target.title } : undefined,
            )
          : continueInstruction(
              briefPath,
              taskText,
              rt.maxBriefChars,
              crossWorkspace ? { title: target.title } : undefined,
            )
      const notOriginNote = notOrigin
        ? `[handoff] 本次为重试，原会话是 ${originSession}；你并非原会话，无法从你的历史确认的内容不要臆造，写进 Open questions。\n`
        : ''
      agent.followup(
        createUserMessage({
          content: [
            {
              type: 'text',
              text: notOriginNote + instruction,
            },
          ],
          source: { kind: 'user' },
        }),
      )

      const pending: PendingHandoff = {
        agent,
        cwd,
        target,
        crossWorkspace,
        briefPath,
        task: taskText,
        ...(recovered === undefined ? {} : { originLabel: originSession }),
        choice,
        preset,
        rememberModel,
        ...(review === undefined ? {} : { review }),
        startedAt: Date.now(),
        stop: () => {},
      }
      rt.pending.set(key, pending)
      startHandoffWatch(rt, pending)

      ctx
        .logger(PACKAGE_NAME)
        .info(recovered === undefined ? 'handoff requested' : 'handoff retry started', {
          session: key,
          briefPath,
          choice: choiceText,
          target: target.path,
        })
      const resumeNote =
        recovered === undefined
          ? undefined
          : existingBrief === undefined
            ? 'Handoff resumed — the brief was never written, so the briefing instruction was re-issued.'
            : 'Handoff resumed — the existing partial brief will be completed in place.'
      return ok(
        [
          resumeNote ?? 'Handoff started.',
          `- Brief target: \`${briefPath}\`${recovered === undefined ? '' : ' (retry)'}`,
          `- Model: ${choiceText}`,
          ...(presetText === undefined ? [] : [`- Preset: ${presetText}`]),
          ...(crossWorkspace ? [`- Target workspace: ${target.title} (\`${target.path}\`)`] : []),
          ...(review === undefined
            ? []
            : [
                `- Auto review: 已请求（最多 ${review.maxRounds} 轮）——绑定随新会话创建进行，成功后本会话标题栏出现「触发」状态；失败会在此通知并降级普通交接`,
              ]),
          crossWorkspace
            ? `The new session appears in workspace "${target.title}" once the brief is complete (timeout ${Math.round(rt.timeoutMs / 1000)}s).`
            : `The new session appears in this workspace's sidebar (title "Handoff: …") once the brief is complete (timeout ${Math.round(rt.timeoutMs / 1000)}s).`,
        ].join('\n'),
      )
    },
  }
}
