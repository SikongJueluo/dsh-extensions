import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name: string): string => readFileSync(join(packageRoot, name), 'utf8')

describe('bundle manifest', () => {
  it('disables the stock policy row with its package-name guard and inserts this package', () => {
    const patch = read('cordis.patch.yml')
    expect(patch).toContain(
      "- id: sandbox-policy\n  name: '@deepseek-ai/dsh-sandbox-policy'\n  disabled: true",
    )
    expect(patch).toContain('id: session-write-access')
    expect(patch).toContain('name: dsh-session-write-access')
    expect(patch).toContain("mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'")
  })

  it('keeps the dev overlay on a built absolute entry and disables source-code protection', () => {
    const patch = read('dev.patch.yml')
    expect(patch).toContain(
      "name: '/home/sikongjueluo/Projects/dsh-extensions/packages/session-write-access/lib/index.js'",
    )
    expect(patch).toContain('protectPluginCode: false')
  })

  it('exports the client half and ships every file the patch names', () => {
    const pkg = JSON.parse(read('package.json')) as {
      main: string
      exports: Record<string, string | { default: string }>
      files: string[]
      dsh: { bundle: { patch: string }; client: { platform: string } }
    }
    expect(pkg.main).toBe('./lib/index.js')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.files).toEqual(
      expect.arrayContaining(['lib', 'cordis.patch.yml', 'dev.patch.yml', 'README.md']),
    )
  })
})
