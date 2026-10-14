/**
 * The model-visible resume notice: what the anchor recorded, what currently
 * holds, and the evidence to pick the work back up from.
 *
 * It rides the standard user-message surface with a first-class
 * `execution-guard` source (the anchor predates this package's split, and the
 * source kind is what the stock Web chat keys the collapsed row on — renaming
 * it would orphan notices already stored in existing session logs), so the
 * summary renders as a collapsed context row and the transcript stays
 * replayable.
 *
 * @module dsh-task-anchor/notice
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

// Merge-extensible source registry (runtime consumers read form/summary
// duck-typed), same pattern as dsh-auto-permit's notices. `hint` belongs to
// dsh-execution-guard, which shares this source kind.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'execution-guard': {
      kind: 'execution-guard'
      form: 'notice' | 'hint'
      summary: string
    }
  }
}

/** Comparison report rendered by {@link buildResumeNotice}. */
export interface ResumeReport {
  readonly anchorPhase: string
  readonly rootMatches: boolean | undefined
  readonly changeMatches: boolean | undefined
  readonly parentsMatch: boolean | undefined
  readonly goalIdMatches: boolean | undefined
  readonly goalRevisionMatches: boolean | undefined
  readonly goalPhaseMatches: boolean | undefined
  readonly anchorGoal?: { goalId: string; revision: number }
  readonly ownedFiles: readonly string[]
  readonly verification: string
}

function mark(matches: boolean | undefined): string {
  if (matches === undefined) return '?'
  return matches ? 'consistent' : 'MISMATCH'
}

/**
 * Build the recovery-anchor notice appended on resume/startup: what the
 * anchor recorded, what currently holds, and the owned-files/verification
 * evidence to pick work back up from. Purely informational — it never
 * performs recovery and is not a repository write lock.
 *
 * @param report - the anchor-vs-current comparison.
 * @returns the frozen user-role notice message.
 */
export function buildResumeNotice(report: ResumeReport): UserMessage {
  const lines = [
    `[execution-guard] recovery anchor for phase "${report.anchorPhase}" — status, not a lock and not an auto-resume:`,
    `repo root: ${mark(report.rootMatches)}; working change: ${mark(report.changeMatches)} (drift is expected after \`jj new\`); parents: ${mark(report.parentsMatch)}`,
  ]
  if (report.anchorGoal !== undefined) {
    const goal = `goal ${report.anchorGoal.goalId} r${report.anchorGoal.revision}: id ${mark(report.goalIdMatches)}, revision ${mark(report.goalRevisionMatches)}, phase ${mark(report.goalPhaseMatches)} (drift is a warning only; a completed or replaced goal is never "consistent")`
    lines.push(goal)
  }
  if (report.ownedFiles.length > 0) {
    lines.push(`owned files: ${report.ownedFiles.join(', ')}`)
  }
  if (report.verification !== '') {
    lines.push(`last verification: ${report.verification}`)
  }
  lines.push('Verify the above before continuing; this anchor records where the task believed it was.')
  const summary = boundContextSummary(
    `execution-guard: anchor ${mark(report.rootMatches)} / change ${mark(report.changeMatches)} (phase ${report.anchorPhase})`,
  )
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'execution-guard', form: 'notice', summary },
  })
}
