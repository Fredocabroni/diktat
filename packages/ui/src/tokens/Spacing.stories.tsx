import type { Meta, StoryObj } from '@storybook/react';

import { spacing } from './spacing.js';

const meta: Meta = {
  title: 'Tokens/Spacing',
};

export default meta;

type Story = StoryObj;

export const Ruler: Story = {
  render: () => (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-2xl font-semibold text-text-primary">
        Spacing scale (4-pt grid)
      </h2>
      <p className="text-sm text-text-secondary">
        Each violet bar shows the visual width of one spacing token.
      </p>
      <div className="flex flex-col gap-2">
        {Object.entries(spacing).map(([key, value]) => (
          <div key={key} className="flex items-center gap-4">
            <code className="w-20 text-xs text-text-tertiary">spacing.{key}</code>
            <code className="w-20 text-xs text-text-secondary">{value}</code>
            <div
              className="h-4 rounded-sm bg-brand"
              style={{ width: value }}
              aria-label={`spacing.${key} bar`}
            />
          </div>
        ))}
      </div>
    </section>
  ),
};
