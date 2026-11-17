import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
