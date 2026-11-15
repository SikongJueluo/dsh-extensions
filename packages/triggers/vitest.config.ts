import { defineConfig } from 'vitest/config'

// The migrated client is TSX; Vitest must use the automatic JSX runtime.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
})
