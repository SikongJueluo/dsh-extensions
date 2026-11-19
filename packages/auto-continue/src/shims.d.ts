import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface PlanUsageWindow {
  percent?: number
  used?: number
  total?: number
  resetAt?: number
}

export interface PlanUsageSnapshot {
  provider: string
  fiveHour?: PlanUsageWindow
  weekly?: PlanUsageWindow
  monthlyMcp?: PlanUsageWindow
  level?: string
  fetchedAt: number
}

export interface PlanUsageServiceShim {
  get(
    provider: string,
    options?: { maxAgeMs?: number; force?: boolean },
  ): Promise<PlanUsageSnapshot | undefined>
}

export type LlmRetryEventData = {
  retryId: string
  turn: number
  step: number
  provider: string
  policyKey: string
  retry: number
  delayMs: number
  failure: LlmFailure
} & ({ mode: 'always' } | { mode: 'normal'; maxRetries: number })

export interface LlmRetryStartedEventData {
  retryId: string
  turn: number
  step: number
  retry: number
}

export interface SessionControllerShim {
  resolveAgent(sessionId: SessionId): Promise<{ agent: Agent } | { error: { code: string } }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    planUsage?: PlanUsageServiceShim

    sessionController?: SessionControllerShim

    workspaceRegistry?: { readonly archivedSessionIds: readonly SessionId[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'llm/retry': LlmRetryEventData
    'llm/retry-started': LlmRetryStartedEventData
  }
}
