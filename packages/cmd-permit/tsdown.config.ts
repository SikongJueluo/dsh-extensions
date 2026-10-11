import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every package here and the official dsh packages:
  // lib/index.js (+ .d.ts). Internal ./x.js modules bundle into the single
  // entry; runtime @deepseek-ai/* stay external (the harness host or the
  // profile install provides them). `dsh-auto-permit` is also external — it
  // is a sibling bundle installed into the same profile's node_modules.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
