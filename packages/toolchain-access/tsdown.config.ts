import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every sibling bundle: lib/index.js (+ .d.ts), internal
  // ./x.js modules bundled into the one entry, runtime host packages
  // (cordis, schemastery, dsh-llm, dsh-sandbox, dsh-sandbox-local) external
  // because the harness host provides them.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
