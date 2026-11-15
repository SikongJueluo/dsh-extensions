import { defineConfig } from 'vitest/config'

// The client source is TSX; Vitest must use the same automatic JSX runtime as
// the Vite client build instead of esbuild's classic default.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
})
