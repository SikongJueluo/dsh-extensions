import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as the official dsh packages and the sibling bundles:
  // lib/index.js (+ .d.ts). Runtime host packages (cordis, schemastery)
  // stay external; fzstd is bundled in.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
