import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // The apply → registerAdapter → stream seam crosses real plugin startup.
    testTimeout: 10_000,
  },
})
