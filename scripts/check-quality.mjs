#!/usr/bin/env node
/**
 * The single quality entry point: local development and CI both run this.
 *
 * Order matters. The cheap, build-free gates come first so a formatting or lint
 * break is reported in seconds; `build` then produces the `lib/` output every
 * later step consumes (the smoke scripts and the client check import it).
 *
 * A step that fails does not stop the run by default: the summary shows the
 * whole gap in one pass. `--fail-fast` stops at the first failure instead.
 *
 *   node scripts/check-quality.mjs              # run every step, then summarise
 *   node scripts/check-quality.mjs --fail-fast  # stop at the first failure
 *   node scripts/check-quality.mjs --list       # print the step list
 *   node scripts/check-quality.mjs --only=lint  # one step (repeatable)
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const STEP_TIMEOUT_MS = 15 * 60_000

/** Every gate, in the order they must run. */
const STEPS = [
  { name: 'format', script: 'format:check', why: 'layout drift, no build needed' },
  { name: 'lint', script: 'lint', why: 'single-file rules + typed rules' },
  { name: 'dead-code', script: 'fallow', why: 'cross-file graph and dependency hygiene' },
  { name: 'types', script: 'typecheck', why: 'per-package tsc, host and client configs' },
  { name: 'build', script: 'build', why: 'lib/ output that every later step consumes' },
  { name: 'tests', script: 'test', why: 'per-package Vitest and node:test suites' },
  { name: 'smoke', script: 'check:smoke', why: 'standalone smoke scripts' },
  { name: 'client', script: 'check:client', why: 'client bundle wrapper and slots' },
  { name: 'pack', script: 'check:pack', why: 'what the published bundle ships' },
  { name: 'storybook', script: 'build:storybook', why: 'stories still compile' },
]

const argv = process.argv.slice(2)
const failFast = argv.includes('--fail-fast')
const only = argv
  .filter((arg) => arg.startsWith('--only='))
  .map((arg) => arg.slice('--only='.length))

if (argv.includes('--list')) {
  for (const step of STEPS)
    console.log(`${step.name.padEnd(10)} pnpm ${step.script.padEnd(16)} ${step.why}`)
  process.exit(0)
}

const unknown = only.filter((name) => !STEPS.some((step) => step.name === name))
if (unknown.length > 0) {
  console.error(`check-quality: unknown step(s): ${unknown.join(', ')}`)
  process.exit(2)
}

const selected = only.length > 0 ? STEPS.filter((step) => only.includes(step.name)) : STEPS

function run(step) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('pnpm', ['run', step.script], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      output += `\n[check-quality] killed after ${STEP_TIMEOUT_MS} ms\n`
    }, STEP_TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal === null ? code : 1, output, elapsed: Date.now() - started })
    })
  })
}

function tail(text, lines = 20) {
  const all = text.trimEnd().split('\n')
  return all.slice(-lines).join('\n')
}

console.log(`check-quality: ${selected.length} step(s)${failFast ? ', fail-fast' : ''}\n`)
const results = []
for (const step of selected) {
  const result = await run(step)
  results.push({ step, ...result })
  if (result.code === 0) {
    console.log(`ok    ${step.name.padEnd(10)} ${String(result.elapsed).padStart(6)} ms`)
    continue
  }
  console.log(
    `FAIL  ${step.name.padEnd(10)} ${String(result.elapsed).padStart(6)} ms  (pnpm ${step.script})`,
  )
  console.log(tail(result.output).replaceAll(/^/gmu, '      '))
  if (failFast) break
}

const failed = results.filter((result) => result.code !== 0)
const skipped = selected.length - results.length
console.log('\ncheck-quality summary')
for (const result of results) {
  console.log(
    `  ${result.code === 0 ? 'ok  ' : 'FAIL'}  ${result.step.name.padEnd(10)} ${result.step.why}`,
  )
}
for (const step of selected.slice(results.length))
  console.log(`  skip  ${step.name.padEnd(10)} ${step.why}`)
if (failed.length > 0) {
  console.error(
    `\ncheck-quality: ${failed.length} step(s) failed${skipped > 0 ? `, ${skipped} skipped` : ''}`,
  )
  process.exit(1)
}
console.log('\ncheck-quality: all steps passed')
