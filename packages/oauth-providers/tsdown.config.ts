import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Match the layout every official dsh package uses: lib/index.js (+ .d.ts).
  // The internal ./x.js modules are bundled into this one entry; runtime
  // packages (@deepseek-ai/*, undici) stay external because the harness host
  // or the profile install provides them.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
