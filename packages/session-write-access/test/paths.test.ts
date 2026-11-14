import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, assertDeploymentRootsSafe, resolveProtectedRoots } from '../src/config.js'
import {
  InvalidWriteRootError,
  ProtectedWriteRootError,
  admitWriteRoot,
  expandPath,
  mergeWritableRoots,
  overlaps,
  physicalDirectory,
} from '../src/paths.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-swa-path-'))
}

describe('write-root admission', () => {
  it('requires an absolute existing physical directory', () => {
    const root = tempDir()
    expect(physicalDirectory(root)).toBe(root)
    expect(() => physicalDirectory('relative/path')).toThrow(InvalidWriteRootError)
    const file = join(root, 'file')
    writeFileSync(file, 'x')
    expect(() => physicalDirectory(file)).toThrow(/not a directory/)
    expect(() => physicalDirectory(join(root, 'missing'))).toThrow(/cannot be read/)
  })

  it('refuses a path containing NUL bytes', () => {
    expect(() => physicalDirectory('/tmp/\0bad')).toThrow(InvalidWriteRootError)
  })

  it('refuses a grant that overlaps a protected path in either direction', () => {
    const root = tempDir()
    const project = join(root, 'project')
    const protectedDir = join(root, 'protected')
    mkdirSync(project)
    mkdirSync(protectedDir)
    expect(admitWriteRoot(project, [protectedDir])).toBe(project)
    expect(() => admitWriteRoot(protectedDir, [protectedDir])).toThrow(ProtectedWriteRootError)
    expect(() => admitWriteRoot(root, [protectedDir])).toThrow(ProtectedWriteRootError)
  })
})

describe('overlap and merge rules', () => {
  it('treats same and nested paths as overlapping, and siblings as distinct', () => {
    expect(overlaps('/a/b', '/a/b')).toBe(true)
    expect(overlaps('/a/b', '/a/b/c')).toBe(true)
    expect(overlaps('/a/b/c', '/a/b')).toBe(true)
    expect(overlaps('/a/b', '/a/bc')).toBe(false)
    expect(overlaps('/a/b', '/a/c')).toBe(false)
  })

  it('treats the filesystem root as containing every absolute path', () => {
    expect(overlaps('/', '/home/u/.dsh')).toBe(true)
    expect(overlaps('/home/u/.dsh', '/')).toBe(true)
    expect(overlaps('/', '/')).toBe(true)
    expect(overlaps('/a', '/')).toBe(true)
  })

  it('deduplicates deployment and group roots while preserving order', () => {
    expect(mergeWritableRoots(['/deploy'], ['/a', '/b'])).toEqual(['/deploy', '/a', '/b'])
    expect(mergeWritableRoots(['/a'], ['/a', '/b'])).toEqual(['/a', '/b'])
    expect(mergeWritableRoots(undefined, [])).toBeUndefined()
  })
})

describe('configuration', () => {
  it('supplies fail-safe stock defaults and accepts policy overrides', () => {
    const defaults = Config({})
    expect(defaults.mode).toBe('read-only')
    expect(defaults.additionalWritableRoots).toEqual([])
    expect(defaults.protectedPaths).toEqual([])
    expect(defaults.protectHomeData).toBe(true)
    expect(defaults.protectPluginCode).toBe(true)
    expect(Config({ mode: 'workspace-write' }).mode).toBe('workspace-write')
  })

  it('expands home and DSH_HOME spellings', () => {
    const environment = { HOME: '/home/u', DSH_HOME: '/home/u/.dsh' }
    expect(expandPath('~/project', environment)).toBe('/home/u/project')
    expect(expandPath('$DSH_HOME/storages', environment)).toBe('/home/u/.dsh/storages')
    expect(expandPath('/absolute', environment)).toBe('/absolute')
  })

  it('protects DSH home and plugin code by default and can be narrowed', () => {
    const root = tempDir()
    const pluginRoot = join(root, 'plugin')
    mkdirSync(pluginRoot)
    const environment = { HOME: root, DSH_HOME: join(root, '.dsh') }
    const defaults = resolveProtectedRoots(Config({}), environment, pluginRoot)
    expect(defaults).toContain(join(root, '.dsh'))
    expect(defaults).toContain(pluginRoot)
    const narrowed = resolveProtectedRoots(
      Config({ protectHomeData: false, protectPluginCode: false }),
      environment,
      pluginRoot,
    )
    expect(narrowed).toEqual([])
  })

  it('refuses the filesystem root as a grant or deployment workspace', () => {
    expect(() => admitWriteRoot('/', ['/home/u/.dsh'])).toThrow(ProtectedWriteRootError)
    expect(() => assertDeploymentRootsSafe(
      Config({ workspaceRoot: '/', additionalWritableRoots: [] }),
      ['/home/u/.dsh'],
    )).toThrow(/overlaps protected/)
  })

  it('refuses a deployment root overlapping protected data at load', () => {
    const root = tempDir()
    const protectedDir = join(root, 'protected')
    mkdirSync(protectedDir)
    expect(() => assertDeploymentRootsSafe(
      Config({ workspaceRoot: root, additionalWritableRoots: [] }),
      [protectedDir],
    )).toThrow(/overlaps protected/)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    expect(() => assertDeploymentRootsSafe(
      Config({ workspaceRoot: workspace, additionalWritableRoots: [] }),
      [protectedDir],
    )).not.toThrow()
  })
})
