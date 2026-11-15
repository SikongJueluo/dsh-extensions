import tailwindcss from '@tailwindcss/vite'
import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: [
    '../packages/ui/src/**/*.stories.@(ts|tsx)',
    '../packages/jj-workspace/src/client/**/*.stories.@(ts|tsx)',
  ],
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(config) {
    config.plugins = [...(config.plugins ?? []), tailwindcss()]
    // Storybook's Vite builder otherwise leaves esbuild on classic JSX; the
    // source uses the automatic runtime and does not import React by hand.
    config.esbuild = { ...config.esbuild, jsx: 'automatic', jsxImportSource: 'react' }
    return config
  },
}

export default config
