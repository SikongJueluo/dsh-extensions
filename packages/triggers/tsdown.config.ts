import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as the other dsh packages: one bundled lib/index.js (+ .d.ts);
  // runtime packages stay external because the harness host or the profile
  // install provides them. zod is external too — dsh-storage-domain brings it.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
