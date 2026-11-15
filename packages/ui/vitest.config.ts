import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    // The pinned host primitives package ships ESM plus CSS Modules. Inline it
    // so Vite (not Node's .css-less loader) transforms both, exactly as the
    // browser and Storybook do.
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
