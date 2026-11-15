import { defineConfig } from 'vitest/config'

// The client source is TSX; Vitest must use the same automatic JSX runtime as
// the Vite client build instead of esbuild's classic default. jsdom backs the
// host Menu/Tooltip primitives the worktree option renders, and the primitives
// package is inlined so Vite (not Node) handles its ESM and CSS Modules.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
