#!/usr/bin/env node
/**
 * Gate step: every inline lint suppression in the tree must be on the approved
 * list below, and every approved entry must still exist.
 *
 * The quality policy allows suppressions only when a rule cannot express the
 * truth (a compiler/protocol limitation) and only after the user approved that
 * exact site, recorded in `docs/quality-gates.md` §6 (A9, A12, A14–A19). This
 * check turns that sentence into something an agent cannot skip: a new
 * `oxlint-disable`/`eslint-disable`/`fallow-ignore` comment, or a new rule on an
 * already-approved line, fails the gate. Adding an entry to `APPROVED` is a
 * policy change and needs the user's approval, exactly like turning a rule off
 * in `.oxlintrc.json`.
 *
 * Stale entries fail too: an approval whose comment disappeared must be
 * removed here, so the list never drifts from the code.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Directories that hold no source of ours. */
const SKIP_DIRS = new Set([
  'node_modules',
  'lib',
  'dist',
  'repo',
  'storybook-static',
  '.git',
  '.jj',
  '.tmp',
  '.dsh',
  '.fallow',
  '.pi',
  '.pnpm-home',
  '.pnpm-run',
  '.pnpm-store',
  '.smoke-dsh-home',
])

/** Source roots to scan, relative to the repo root. */
const SCAN_ROOTS = ['packages', 'tooling', 'scripts', '.storybook', '.github']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js'])

/**
 * Approved inline suppressions: `file` → rule ids allowed there.
 *
 * Each entry names the §6 approval that covers it. Keep this list sorted by
 * path; the check compares it with the tree in both directions.
 */
const APPROVED = [
  // A12: the .mjs smoke is the only caller; Fallow cannot attribute a JS call site.
  ['packages/auto-continue/src/spool.ts', ['unused-class-member']],
  ['packages/auto-env/src/direnv.ts', ['eslint/no-control-regex', 'unused-class-member']],
  // A25: the deprecated synchronous session-log readers (`snapshotEvents`,
  // `ownEvents`) have no sync replacement; the sanctioned ones are async and
  // optional, so migrating changes exported contracts and control flow.
  ['packages/auto-continue/src/resume.ts', ['typescript/no-deprecated']],
  ['packages/auto-continue/src/restart.ts', ['typescript/no-deprecated']],
  ['packages/auto-permit/src/evidence.ts', ['typescript/no-deprecated']],
  // A23: the SDK's ShellExecSpec.env cannot spell an unset tombstone.
  ['packages/auto-env/src/index.ts', ['typescript/no-unsafe-type-assertion']],
  ['packages/context-audit/src/client/index.tsx', ['react/set-state-in-effect']],
  // A15 + A19: autoFocus is a desktop-only enhancement; the effect mirrors
  // external data into local UI state.
  ['packages/handoff/src/client/index.tsx', ['jsx-a11y/no-autofocus', 'react/set-state-in-effect']],
  // A14: tsgolint misreads `await` in a for-of head; `tsc` proves the call returns a Promise.
  ['packages/handoff/src/selection.ts', ['typescript/await-thenable']],
  // A9: pre-existing hook-dependency dels; handled per site in the fix layer.
  ['packages/jj-workspace/src/client/index.tsx', ['react-hooks/exhaustive-deps']],
  ['packages/jj-workspace/src/client/worktree-option.tsx', ['react/set-state-in-effect']],
  // A17: tsgolint misreads the `promisify(execFile)` overload; `tsc` accepts it.
  ['packages/more-providers/src/oauth/transport.ts', ['typescript/strict-void-return']],
  ['packages/more-providers/src/client/oauth.tsx', ['react-hooks/exhaustive-deps']],
  ['packages/plan-usage/src/client/index.tsx', ['react-hooks/exhaustive-deps']],
  // A16: the pattern exists to match ANSI escapes.
  ['packages/remote-exec/src/display.ts', ['eslint/no-control-regex']],
  // A12: only the .mjs smoke reads the class member.
  ['packages/rtk-rewrite/src/rewrite.ts', ['unused-class-member']],
  // A28: a tool output schema types the value as JsonValue[], while the SDK's
  // ContentBlock interfaces carry no index signature and no converter exists.
  ['packages/crew/src/index.ts', ['typescript/no-unsafe-type-assertion']],
  // A24: `DomainFacility.get` is the SDK's untyped diagnostic surface; only
  // `open` is typed and it rejects an already-open domain on hot reload.
  ['packages/handoff/src/preferences.ts', ['typescript/no-unsafe-type-assertion']],
  ['packages/session-write-access/src/service.ts', ['typescript/no-unsafe-type-assertion']],
  ['packages/session-write-access/src/client/index.tsx', ['react/set-state-in-effect']],
  ['packages/triggers/src/client/index.tsx', ['react/set-state-in-effect']],
  // A26: the blocking confirmation IS the cancel gate (A19 class); A27: the
  // host slot passes the store hook as a prop.
  ['packages/triggers/src/client/index.tsx', ['eslint/no-alert', 'react/hooks']],
  // A19: role is required by the Base UI primitive contract.
  ['packages/ui/src/components/progress.tsx', ['jsx-a11y/prefer-tag-over-role']],
  ['packages/ui/src/components/spinner.tsx', ['jsx-a11y/prefer-tag-over-role']],
]

/** `oxlint-disable-next-line <rules> -- reason` and the block forms. */
const DISABLE_PATTERN =
  /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line)?\s+([^\n*]+?)(?:\s+--\s[^\n*]*)?(?:\*\/)?$/gmu
/** `fallow-ignore-next-line <rule> -- reason` and the block form. */
const FALLOW_PATTERN =
  /(?:\/\/|\/\*)\s*fallow-ignore(?:-next-line)?\s+([^\n*]+?)(?:\s+--\s[^\n*]*)?(?:\*\/)?$/gmu

const toKey = (path) => path.split(sep).join('/')

async function* sourceFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      // Skip every dot-directory except the ones we scan explicitly.
      if (
        entry.name.startsWith('.') &&
        !SCAN_ROOTS.includes(relative(ROOT, join(dir, entry.name)))
      ) {
        continue
      }
      yield* sourceFiles(join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !EXTENSIONS.has(entry.name.slice(dot))) continue
    yield join(dir, entry.name)
  }
}

/** Rule ids on one disable comment, minus the `-- reason` tail. */
function rulesOf(text) {
  const withoutReason = text.split(/\s+--\s/u)[0]
  return withoutReason
    .split(/[,\s]+/u)
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0 && rule !== '-next-line')
}

const found = new Map()
for (const root of SCAN_ROOTS) {
  for await (const file of sourceFiles(join(ROOT, root))) {
    const text = await readFile(file, 'utf8')
    if (
      !text.includes('oxlint-disable') &&
      !text.includes('eslint-disable') &&
      !text.includes('fallow-ignore')
    ) {
      continue
    }
    const key = toKey(relative(ROOT, file))
    for (const pattern of [DISABLE_PATTERN, FALLOW_PATTERN]) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length
        for (const rule of rulesOf(match[1])) {
          const id = `${key}#${line} ${rule}`
          found.set(id, { file: key, rule })
        }
      }
    }
  }
}

const approved = new Map()
for (const [file, rules] of APPROVED) {
  for (const rule of rules) approved.set(`${file} ${rule}`, true)
}

const unexpected = []
for (const { file, rule } of found.values()) {
  if (!approved.has(`${file} ${rule}`)) unexpected.push(`${file}: ${rule}`)
}

const stale = []
const seen = new Set([...found.values()].map(({ file, rule }) => `${file} ${rule}`))
for (const [file, rules] of APPROVED) {
  for (const rule of rules) {
    if (!seen.has(`${file} ${rule}`)) stale.push(`${file}: ${rule}`)
  }
}

let failures = 0
if (unexpected.length > 0) {
  failures += unexpected.length
  console.error('check-suppressions: inline suppression without an approved entry')
  console.error('  (adding one is a policy change: docs/quality-gates.md §6, user approval)')
  for (const entry of unexpected.toSorted()) console.error(`  + ${entry}`)
}
if (stale.length > 0) {
  failures += stale.length
  console.error('check-suppressions: approved entry no longer exists in the tree')
  console.error('  (remove it from scripts/check-suppressions.mjs and the docs)')
  for (const entry of stale.toSorted()) console.error(`  - ${entry}`)
}

if (failures > 0) {
  console.error(`check-suppressions: ${failures} mismatch(es)`)
  process.exit(1)
}
console.log(
  `check-suppressions: ${found.size} inline suppression(s), all approved (${APPROVED.length} sites)`,
)
