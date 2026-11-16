import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRecord } from '../src/channel.js'

const packageRoot = dirname(import.meta.dirname)
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
    const pkg: unknown = JSON.parse(read('package.json'))
    if (!isRecord(pkg)) throw new Error('package.json is not an object')
    const exportsMap = isRecord(pkg.exports) ? pkg.exports : undefined
    const dsh = isRecord(pkg.dsh) ? pkg.dsh : undefined
    const bundle = dsh !== undefined && isRecord(dsh.bundle) ? dsh.bundle : undefined
    const client = dsh !== undefined && isRecord(dsh.client) ? dsh.client : undefined
    expect(pkg.main).toBe('./lib/index.js')
    expect(exportsMap?.['./client']).toBe('./lib/client.js')
    expect(bundle?.patch).toBe('./cordis.patch.yml')
    expect(client?.platform).toBe('web')
    expect(pkg.files).toEqual(
      expect.arrayContaining(['lib', 'cordis.patch.yml', 'dev.patch.yml', 'README.md']),
    )
  })
})
