import { defineConfig, type UserConfig } from 'tsdown'

export interface HostBuildOptions {
  /** Host entries relative to the package root; defaults to `src/index.ts`. */
  entry?: string[]
}

/**
 * Shared tsdown preset for the Node half of every bundle.
 *
 * The output layout matches the official DSH packages: `lib/index.js` plus
 * `lib/index.d.ts`, ESM, Node 20. Runtime `@deepseek-ai/*` packages stay
 * external because the host or the profile install provides them; type-only
 * imports are erased. `clean: false` keeps the client half's `lib/client.js`
 * alive when only the host half rebuilds.
 */
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
