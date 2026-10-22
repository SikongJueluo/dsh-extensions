/**
 * Seed-parity tests: the bundle patch (cordis.patch.yml) and the dev/deploy
 * overlay (dev.patch.yml) are BOTH executable entry points — a diverging
 * dev overlay would silently re-open the coarse full-access exits the
 * bundle seed closed, and make dev-loop behavior differ from what ships.
 *
 * @module dsh-cmd-permit/seed-parity.test
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))

interface EscalationDefaults {
  allow: string[]
  maxMode: string
}

/** Read the escalation defaults from one of this package's patch files. */
function escalationDefaults(file: string): EscalationDefaults {
  const text = readFileSync(join(packageDir, file), 'utf8')
  // Both files pin flow-style lists under the cmd-permit row's config.
  const allow = /\ballow:\s*\[([^\]]*)\]/u.exec(text)
  const maxMode = /\bmaxMode:\s*['"]?([\w-]+)/u.exec(text)
  if (allow === null || maxMode === null) {
    throw new Error(`cannot read escalation defaults from ${file}`)
  }
  return {
    allow: allow[1]!
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
      .filter((entry) => entry !== ''),
    maxMode: maxMode[1]!,
  }
}

describe('escalation defaults across entry points', () => {
  it('the bundle seed and the dev overlay are identical', () => {
    expect(escalationDefaults('cordis.patch.yml')).toEqual(escalationDefaults('dev.patch.yml'))
  })

  it('the seed allowlist stays empty (no default full-access command exits)', () => {
    // The migration closed the cargo/direnv/rtk exits: no command head may
    // receive Full access by default, from any shipped entry point. If
    // this fails, either entry re-opened a coarse exit — update it (and
    // the migration docs) deliberately, not by accident.
    expect(escalationDefaults('cordis.patch.yml').allow).toEqual([])
    expect(escalationDefaults('dev.patch.yml').allow).toEqual([])
  })
})
