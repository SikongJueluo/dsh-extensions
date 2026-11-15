import type { Preview } from '@storybook/react-vite'
import './preview.css'

const preview: Preview = {
  parameters: {
    layout: 'padded',
    controls: { expanded: false },
  },
  globalTypes: {
    theme: {
      description: 'DSH theme tokens',
      defaultValue: 'dark',
      toolbar: {
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div className="storybook-canvas" data-theme={context.globals.theme ?? 'dark'}>
        <Story />
      </div>
    ),
  ],
}

export default preview
