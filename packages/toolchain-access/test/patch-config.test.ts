/**
 * The bundle and dev patch layers must not restate the preset list: with
 * `presets` omitted, the row config resolves through the plugin schema and
 * the seven default presets switch on — a hardcoded `presets: []` here would
 * silently disable that default for every deployment.
 *
 * @module dsh-toolchain-access/patch-config.test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_PRESETS } from '../src/index.js'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('patch layers defer presets to the schema default', () => {
  for (const patch of ['cordis.patch.yml', 'dev.patch.yml']) {
    it(`${patch} mounts the row with config { paths: {} } and no presets key`, () => {
      const text = readFileSync(join(packageDir, patch), 'utf8')
      expect(text).toMatch(/^\s*- id: toolchain-sandbox$/m)
      expect(text).toContain('config:\n        paths: {}')
      expect(text).not.toMatch(/^\s+presets:/m)
      expect(Config({ paths: {} }).presets).toEqual(DEFAULT_PRESETS)
    })
  }
})
