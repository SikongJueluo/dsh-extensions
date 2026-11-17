#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeText, collectFiles } from './comments/analyze.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
try {
  const files = await collectFiles(args)
  let failures = 0
  for (const file of files) {
    const label = relative(root, file)
    try {
      const { diagnostics } = analyzeText(file, await readFile(file, 'utf8'))
      for (const item of diagnostics) {
        failures += 1
        console.error(`${label}:${item.line}: ${item.message}`)
      }
    } catch (error) {
      failures += 1
      console.error(`${label}: parser failure: ${error.message}`)
    }
  }
  if (failures) {
    console.error(`check-comments: ${failures} failure(s) across ${files.length} file(s)`)
    process.exitCode = 1
  } else console.log(`check-comments: ${files.length} file(s), no comment violations`)
} catch (error) {
  console.error(`check-comments: ${error.message}`)
  process.exitCode = 2
}
