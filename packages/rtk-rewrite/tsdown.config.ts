import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every package here: lib/index.js (+ .d.ts). Internal
  // modules bundle into the entry; runtime packages stay external — the
  // harness host or the profile install provides @deepseek-ai/*, and
  // `dsh-auto-env` is a sibling bundle installed into the same profile.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
