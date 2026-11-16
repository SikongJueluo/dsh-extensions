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
  async viteFinal(finalConfig) {
    finalConfig.plugins = [...(finalConfig.plugins ?? []), tailwindcss()]
    // Storybook's Vite builder otherwise leaves esbuild on classic JSX; the
    // source uses the automatic runtime and does not import React by hand.
    finalConfig.esbuild = { ...finalConfig.esbuild, jsx: 'automatic', jsxImportSource: 'react' }
    return finalConfig
  },
}

export default config
