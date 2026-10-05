import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Match the layout every official dsh package and every sibling bundle
  // uses: lib/index.js (+ .d.ts). Runtime packages (@deepseek-ai/cordis,
  // @deepseek-ai/dsh-tools, @deepseek-ai/dsh-subagent) stay external because
  // the harness host provides them. Everything else is type-only, erased at
  // build time.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
