import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Match the layout every official dsh package and both sibling bundles use:
  // lib/index.js (+ .d.ts). Internal ./x.js modules are bundled into this one
  // entry; runtime packages (@deepseek-ai/cordis, @deepseek-ai/schemastery)
  // stay external because the harness host provides them. Everything else
  // (dsh-client-connection, …) is a type-only import, erased at build time.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
