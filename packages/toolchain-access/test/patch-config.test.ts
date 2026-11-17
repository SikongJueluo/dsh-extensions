/** @module dsh-toolchain-access/patch-config.test */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_PRESETS } from '../src/index.js'

const packageDir = join(import.meta.dirname, '..')

describe('patch layers defer presets to the schema default', () => {
  for (const patch of ['cordis.patch.yml', 'dev.patch.yml']) {
    it(`${patch} mounts the row with config { paths: {} } and no presets key`, () => {
      const text = readFileSync(join(packageDir, patch), 'utf8')
      expect(text).toMatch(/^\s*- id: toolchain-sandbox$/mu)
      expect(text).toContain('config:\n        paths: {}')
      expect(text).not.toMatch(/^\s+presets:/mu)
      expect(Config({ paths: {} }).presets).toEqual(DEFAULT_PRESETS)
    })
  }
})
