import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PLUGIN_NAME } from './identity.js'
import { registerRecovery } from './recovery.js'
import { registerResume } from './resume.js'
import { registerCommands } from './command.js'
import { registerRestartResume } from './restart.js'
import { WaitSpool } from './spool.js'
import { DEFAULT_MAX_WAIT_MS, DEFAULT_RESET_MARGIN_MS } from './schedule.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export { planResetWait, planProbeWait } from './schedule.js'
export { cancellableSleep, registerRecovery } from './recovery.js'
export { WaitSpool, defaultSpoolPath } from './spool.js'
export type { PendingWait } from './spool.js'
export { registerResume, resumeMessage, RETRY_LATER_MS } from './resume.js'
export { registerRestartResume, defaultMirrorPath, RESTART_RESUME_MESSAGE } from './restart.js'
export {
  PROBE_SCHEDULE_MS,
  PROBE_TIGHTEN_AFTER_MS,
  PROBE_TIGHT_DELAY_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RESET_MARGIN_MS,
} from './schedule.js'
export type { ScheduleOptions, WaitPlan } from './schedule.js'

export interface Config {
  maxWaitMs: number

  resetMarginMs: number

  persist: boolean

  resumeOnRestart: boolean

  resumeMaxAgeMs: number
}

export const Config: Schema<Config> = Schema.object({
  maxWaitMs: Schema.number()
    .step(1)
    .min(60_000)
    .default(DEFAULT_MAX_WAIT_MS)
    .description(
      'Total budget to keep waiting for a quota reset before giving up and failing the turn (ms).',
    ),
  resetMarginMs: Schema.number()
    .step(1)
    .min(0)
    .default(DEFAULT_RESET_MARGIN_MS)
    .description('Extra slack after the reported window reset before retrying (ms).'),
  persist: Schema.boolean()
    .default(true)
    .description(
      'Persist in-flight waits so a harness restart still resumes the session at the quota reset.',
    ),
  resumeOnRestart: Schema.boolean()
    .default(true)
    .description(
      'Resume sessions whose turn was running when the harness stopped (restart mirror).',
    ),
  resumeMaxAgeMs: Schema.number()
    .step(1)
    .min(60_000)
    .default(12 * 60 * 60 * 1000)
    .description('Max age of a restart-mirror entry before it is no longer resumed (ms).'),
})

export const name = PLUGIN_NAME
export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  const spool = config.persist ? new WaitSpool({ logger: ctx.logger }) : undefined
  const cancelled = new Set<string>()
  const adopter =
    spool === undefined ? undefined : registerResume(ctx, { maxWaitMs: config.maxWaitMs }, spool)
  registerRecovery(ctx, {
    maxWaitMs: config.maxWaitMs,
    resetMarginMs: config.resetMarginMs,
    spool,
    cancelled,
    onWaitKept: (entry) => adopter?.schedule(entry),
  })
  if (adopter !== undefined && spool !== undefined) {
    registerCommands(ctx, { adopter, spool, cancelled })
  }
  registerRestartResume(ctx, {
    resumeOnRestart: config.resumeOnRestart,
    resumeMaxAgeMs: config.resumeMaxAgeMs,
  })
}
