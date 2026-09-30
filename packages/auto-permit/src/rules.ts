/**
 * Hard high-risk command shapes that never reach the judge model.
 *
 * A hit does NOT reject anything — it routes the approval back to the human
 * answerer (`next()`). These encode the irreversibility boundary from the pi
 * ai-bash-judge ADR work: operations that destroy unrecoverable data or
 * escalate privileges are a human decision even when the prompt names them,
 * and even when an identical command was allowed before. The shapes are
 * deliberately conservative (false positives just cost a dialog).
 */

/** One anchored shape: matches the whole command string case-insensitively. */
const SHAPES: RegExp[] = [
  // Destructive removal aimed at home, env-derived, or any absolute path
  // outside the workspace-relative forms (./…, …/…).
  /\brm\s[^;|&]*?-[a-zA-Z]*f[a-zA-Z]*[^;|&]*?(?:~|\$\{?HOME\}?|(?:^|\s)\/(?:[\w.$-]|$))/,
  // Discarding uncommitted work / untracked files.
  /\bgit\s+clean\b[^;|&]*-[a-zA-Z]*x/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+(?:--\s+)?\./,
  /\bgit\s+restore\b[^;|&]*\.\s*$/,
  /\bgit\s+stash\s+(?:drop|clear)\b/,
  // Rewriting published history.
  /\bgit\s+push\b[^;|&]*(--force\b|--force-with-lease\b|\s-f\b)/,
  // Privilege escalation.
  /(^|[;&|\s])sudo\b/,
  // Remote-execution pipelines.
  /\b(curl|wget)\b[^;|&]*\|\s*(ba)?sh\b/,
]

/**
 * Test one bash command against the high-risk shapes.
 *
 * @param command - the complete bash input.
 * @returns true when the command must go to the human dialog untouched.
 */
export function isHighRisk(command: string): boolean {
  return SHAPES.some((shape) => shape.test(command))
}
