import type { Preview } from '@storybook/react';
import React from 'react';

import '../src/styles.css';
import './tailwind.css';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'diktat-dark',
      values: [
        { name: 'diktat-dark', value: '#0a0a0f' },
        { name: 'paper', value: '#fafafc' },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        {
          className:
            'dark min-h-screen bg-[var(--color-surface-app,#0a0a0f)] p-8 text-[var(--color-text-primary,#fff)] font-sans',
        },
        React.createElement(Story),
      ),
  ],
};

export default preview;
