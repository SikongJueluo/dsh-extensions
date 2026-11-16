#!/usr/bin/env node
// Pack guard: the tarball a consumer installs must contain the built host and
// client halves plus the bundle patch, and must not depend on the source tree.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const checked = []

for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(root, 'packages', entry.name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.dsh?.bundle) continue

  const out = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  const problems = []
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    const tarball = readdirSync(out).find((name) => name.endsWith('.tgz'))
    if (!tarball) {
      problems.push('pnpm pack produced no tarball')
    } else {
      const listing = execFileSync('tar', ['-tzf', join(out, tarball)], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.replace(/^package\//, ''))
        .filter(Boolean)
      const required = ['package.json', 'lib/index.js', 'cordis.patch.yml']
      if (manifest.dsh.client) required.push('lib/client.js')
      for (const file of required) {
        if (!listing.includes(file)) problems.push(`missing ${file}`)
      }
      for (const file of listing) {
        if (file.startsWith('src/') || file.startsWith('client/')) {
          problems.push(`leaks source file ${file}`)
        }
      }
    }
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    problems.push(
      `pnpm pack failed${stderr ? `: ${stderr.split('\n').slice(-3).join(' | ')}` : ''}`,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }

  checked.push(manifest.name)
  if (problems.length > 0) failures.push([manifest.name, problems])
}

if (failures.length > 0) {
  for (const [name, problems] of failures) {
    process.stderr.write(`\n${name}\n`)
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  }
  process.stderr.write(`\npacked bundles: ${failures.length}/${checked.length} failed\n`)
  process.exit(1)
}

process.stdout.write(`packed bundles: ${checked.length} ok (${checked.join(', ')})\n`)
