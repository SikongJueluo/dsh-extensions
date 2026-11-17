/** @module dsh-cmd-permit/seed-parity.test */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const packageDir = dirname(import.meta.dirname)

interface EscalationDefaults {
  allow: string[]
  maxMode: string
}

/** Read the escalation defaults from one of this package's patch files. */
function escalationDefaults(file: string): EscalationDefaults {
  const text = readFileSync(join(packageDir, file), 'utf8')
  const allow = /\ballow:\s*\[([^\]]*)\]/u.exec(text)
  const maxMode = /\bmaxMode:\s*['"]?([\w-]+)/u.exec(text)
  const allowBody = allow?.[1]
  const modeSource = maxMode?.[1]
  if (allowBody === undefined || modeSource === undefined) {
    throw new Error(`cannot read escalation defaults from ${file}`)
  }
  return {
    allow: allowBody
      .split(',')
      .map((entry) => entry.trim().replaceAll(/^['"]|['"]$/gu, ''))
      .filter((entry) => entry !== ''),
    maxMode: modeSource,
  }
}

describe('escalation defaults across entry points', () => {
  it('the bundle seed and the dev overlay are identical', () => {
    expect(escalationDefaults('cordis.patch.yml')).toEqual(escalationDefaults('dev.patch.yml'))
  })

  it('the seed allowlist stays empty (no default full-access command exits)', () => {
    expect(escalationDefaults('cordis.patch.yml').allow).toEqual([])
    expect(escalationDefaults('dev.patch.yml').allow).toEqual([])
  })
})
