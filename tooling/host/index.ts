/** @module tooling/host/index */
import { defineConfig, type UserConfig } from 'tsdown'

export interface HostBuildOptions {
  entry?: string[]
}

export function defineHostConfig({ entry = ['src/index.ts'] }: HostBuildOptions = {}): UserConfig {
  return defineConfig({
    entry,
    outDir: 'lib',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    format: 'esm',
    platform: 'node',
    target: 'node20',
    dts: true,
    clean: false,
  })
}
