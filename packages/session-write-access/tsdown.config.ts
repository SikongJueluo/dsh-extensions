import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every sibling bundle: lib/index.js (+ .d.ts), internal
  // ./x.js modules bundled into the one entry. Runtime @deepseek-ai/* packages
  // stay external because the harness host provides them; the browser half is
  // served verbatim from client/.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
