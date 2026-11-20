#!/usr/bin/env node
/** @module scripts/check-suppressions */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { suppressionRules } from './comments/suppressions.mjs'

const ROOT = join(import.meta.dirname, '..')

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

const SCAN_ROOTS = ['packages', 'tooling', 'scripts', '.storybook', '.github']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx'])

const APPROVED = [
  ['packages/auto-continue/src/spool.ts', ['unused-class-member']],
  ['packages/auto-env/src/direnv.ts', ['eslint/no-control-regex', 'unused-class-member']],

  ['packages/auto-continue/src/resume.ts', ['typescript/no-deprecated']],
  ['packages/auto-continue/src/restart.ts', ['typescript/no-deprecated']],
  ['packages/auto-permit/src/evidence.ts', ['typescript/no-deprecated']],

  ['packages/auto-env/src/index.ts', ['typescript/no-unsafe-type-assertion']],
  ['packages/context-audit/src/client/index.tsx', ['react/set-state-in-effect']],

  ['packages/handoff/src/client/index.tsx', ['jsx-a11y/no-autofocus', 'react/set-state-in-effect']],

  ['packages/handoff/src/selection.ts', ['typescript/await-thenable']],

  ['packages/jj-workspace/src/client/index.tsx', ['react-hooks/exhaustive-deps']],
  ['packages/jj-workspace/src/client/worktree-option.tsx', ['react/set-state-in-effect']],

  ['packages/more-providers/src/oauth/transport.ts', ['typescript/strict-void-return']],
  ['packages/more-providers/src/client/providers.tsx', ['react-hooks/exhaustive-deps']],
  ['packages/plan-usage/src/client/index.tsx', ['react-hooks/exhaustive-deps']],

  ['packages/remote-exec/src/display.ts', ['eslint/no-control-regex']],

  ['packages/rtk-rewrite/src/rewrite.ts', ['unused-class-member']],

  ['packages/crew/src/index.ts', ['typescript/no-unsafe-type-assertion']],

  ['packages/handoff/src/preferences.ts', ['typescript/no-unsafe-type-assertion']],
  ['packages/session-write-access/src/service.ts', ['typescript/no-unsafe-type-assertion']],
  ['packages/triggers/src/client/index.tsx', ['react/set-state-in-effect']],

  ['packages/triggers/src/client/index.tsx', ['eslint/no-alert', 'react/hooks']],

  ['packages/ui/src/components/progress.tsx', ['jsx-a11y/prefer-tag-over-role']],
  ['packages/ui/src/components/spinner.tsx', ['jsx-a11y/prefer-tag-over-role']],
]

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

const found = new Map()
for (const root of SCAN_ROOTS) {
  for await (const file of sourceFiles(join(ROOT, root))) {
    const text = await readFile(file, 'utf8')
    const key = toKey(relative(ROOT, file))
    for (const { line, rule } of suppressionRules(file, text)) {
      const id = `${key}#${line} ${rule}`
      found.set(id, { file: key, rule })
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
