import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every sibling bundle: lib/index.js (+ .d.ts). The dsh host
  // provides @deepseek-ai/dsh-llm-pi-ai and pi-ai, so both stay external.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
