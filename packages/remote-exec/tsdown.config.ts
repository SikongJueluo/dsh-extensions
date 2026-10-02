import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Same layout as every sibling bundle: one lib/index.js (+ .d.ts). Internal
  // ./exec.js is bundled into the entry; runtime packages (@deepseek-ai/cordis,
  // @deepseek-ai/schemastery, @deepseek-ai/dsh-tools for defineTool) stay
  // external — the harness host (or this repo's hoisted node_modules) provides
  // them. Everything else (dsh-subprocess, dsh-user-approval, dsh-agent) is a
  // type-only import, erased at build time.
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
})
