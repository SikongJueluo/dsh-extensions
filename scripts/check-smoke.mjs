#!/usr/bin/env node
/** @module scripts/check-smoke */

import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const TIMEOUT_MS = 180_000

const EXCLUDED = new Map([
  [
    'packages/search-integrator/scripts/smoke-research.mjs',
    'calls real provider endpoints; needs ZHIPU_API_KEY / EXA_API_KEY and network',
  ],
])

const REQUIRED_BINARIES = ['git', 'jj']

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function discover() {
  const found = []
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const smoke = join('packages', entry.name, 'smoke.mjs')
    if (await isFile(join(ROOT, smoke))) found.push(smoke)
    const scriptsDir = join('packages', entry.name, 'scripts')
    let files = []
    try {
      files = await readdir(join(ROOT, scriptsDir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith('smoke-') || !file.name.endsWith('.mjs')) continue
      found.push(join(scriptsDir, file.name))
    }
  }
  return found.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function run(script, { verbose }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    if (!verbose) {
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      output += `\n[check-smoke] killed after ${TIMEOUT_MS} ms\n`
    }, TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal === null ? code : 1, signal, output })
    })
  })
}

function tail(text, lines = 12) {
  const all = text.trimEnd().split('\n')
  return all.slice(-lines).join('\n')
}

const listOnly = process.argv.includes('--list')
const verbose = process.argv.includes('--verbose')

const scripts = await discover()

const stale = [...EXCLUDED.keys()].filter((script) => !scripts.includes(script))
if (stale.length > 0) {
  console.error(`check-smoke: stale exclusion(s), file is gone: ${stale.join(', ')}`)
  process.exit(1)
}

const runnable = scripts.filter((script) => !EXCLUDED.has(script))
const excluded = scripts.filter((script) => EXCLUDED.has(script))

if (listOnly) {
  for (const script of runnable) console.log(`run      ${script}`)
  for (const script of excluded) console.log(`skip     ${script} — ${EXCLUDED.get(script)}`)
  process.exit(0)
}

const missing = []
for (const binary of REQUIRED_BINARIES) {
  const probe = spawn(binary, ['--version'], { stdio: 'ignore' })
  const found = await new Promise((resolve) => {
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
  if (!found) missing.push(binary)
}
if (missing.length > 0) {
  console.error(`check-smoke: missing required program(s): ${missing.join(', ')}`)
  console.error(
    'These are provided by the host environment (see docs/quality-acceptance-inventory.md).',
  )
  process.exit(1)
}

console.log(`check-smoke: ${runnable.length} script(s), ${excluded.length} excluded`)
const failures = []
for (const script of runnable) {
  const started = Date.now()
  const result = await run(script, { verbose })
  const elapsed = Date.now() - started
  const label = relative(ROOT, join(ROOT, script))
  if (result.code === 0) {
    console.log(`ok    ${label} (${elapsed} ms)`)
    continue
  }
  console.log(`FAIL  ${label} (${elapsed} ms, code ${String(result.code)})`)
  console.log(tail(result.output).replaceAll(/^/gmu, '      '))
  failures.push(label)
}

for (const script of excluded) console.log(`skip  ${script} — ${EXCLUDED.get(script)}`)

if (failures.length > 0) {
  console.error(`\ncheck-smoke: ${failures.length} script(s) failed`)
  process.exit(1)
}
console.log('\ncheck-smoke: all scripts passed')
