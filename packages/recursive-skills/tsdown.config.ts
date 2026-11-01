import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every sibling bundle: lib/index.js (+ .d.ts). Host packages
  // (cordis, schemastery, dsh-skill, dsh-fs, dsh-home-paths) and the `yaml`
  // runtime dependency stay external because the profile install provides them.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
