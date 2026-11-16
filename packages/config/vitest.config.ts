import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Real files and the native directory watcher are the contract here.
    testTimeout: 10_000,
  },
})
