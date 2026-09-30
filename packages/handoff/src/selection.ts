/**
 * Resolving the origin session's *effective* model route.
 *
 * `agent.options` only records what the agent was created with; a `/model`
 * switch — provider, model, and the reasoning effort — lands in the session's
 * durable `modelSelection` projection instead. Inheriting from `agent.options`
 * therefore handed the fresh session a stale or missing effort. This module
 * reads the projection the same way the /model popup does: the pending
 * selection first, the last used one second, and only then the creation
 * options.
 *
 * @module dsh-handoff/selection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
// Type-only: pull the `Context.sessionProjections` augmentation and the
// `modelSelection` projection key (registered by the session controller) in.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller'

/** A provider/model pair plus the reasoning effort in force, as the UI describes it. */
export interface RouteSummary {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Narrow the projection's selection shape into our owned route summary. */
function toRoute(selection: { provider: string; model: string; reasoningEffort?: string }): RouteSummary {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/** The origin agent's creation options, when they name a complete route. */
function optionRoute(agent: Agent): RouteSummary | undefined {
  const { provider, model, reasoningEffort } = agent.options
  if (provider === undefined || model === undefined) return undefined
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/**
 * The route the origin session is actually on: its durable selection
 * (pending first, then last used), falling back to the agent's creation
 * options. Returns `undefined` only when neither source names a route.
 */
export function sessionRoute(ctx: Context, agent: Agent): RouteSummary | undefined {
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined) {
    const state = projections.stateOf(agent.session, 'modelSelection')
    const selection = state?.pending ?? state?.lastUsed ?? undefined
    if (selection !== undefined && selection !== null) return toRoute(selection)
  }
  return optionRoute(agent)
}

/** The deployment's global default route, effort included. */
export function defaultRoute(ctx: Context): RouteSummary | undefined {
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  return selection === undefined ? undefined : toRoute(selection)
}

/**
 * Turn a route into agent-creation options. `maxTokens` is deliberately not
 * part of a route: callers that inherit from the origin session add it
 * separately, and a switched model keeps its own default.
 */
export function toAgentOptions(route: RouteSummary | undefined): AgentOptions | undefined {
  if (route === undefined) return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: route.reasoningEffort as AgentOptions['reasoningEffort'] }),
  }
}
