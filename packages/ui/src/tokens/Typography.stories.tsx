import type { Meta, StoryObj } from '@storybook/react';

import { fontSize, fontWeight, letterSpacing } from './typography.js';

const meta: Meta = {
  title: 'Tokens/Typography',
};

export default meta;

type Story = StoryObj;

const SAMPLE = 'Politics is a combat sport.';

function Row({ label, size, family }: { label: string; size: string; family: 'sans' | 'display' }) {
  return (
    <div className="flex flex-col gap-1 border-b border-ink-300 py-3">
      <code className="text-xs text-text-tertiary">
        fontSize.{label} • {size}
      </code>
      <p className={family === 'display' ? 'font-display' : 'font-sans'} style={{ fontSize: size }}>
        {SAMPLE}
      </p>
    </div>
  );
}

export const SansScale: Story = {
  render: () => (
    <section className="flex flex-col">
      <h2 className="font-display text-2xl font-semibold text-text-primary">
        Sans (Inter Variable)
      </h2>
      {Object.entries(fontSize).map(([k, v]) => (
        <Row key={k} label={k} size={v[0]} family="sans" />
      ))}
    </section>
  ),
};

export const DisplayScale: Story = {
  render: () => (
    <section className="flex flex-col">
      <h2 className="font-display text-2xl font-semibold text-text-primary">
        Display (Inter Display)
      </h2>
      {Object.entries(fontSize).map(([k, v]) => (
        <Row key={k} label={k} size={v[0]} family="display" />
      ))}
    </section>
  ),
};

export const Weights: Story = {
  render: () => (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-2xl font-semibold text-text-primary">Font weights</h2>
      {Object.entries(fontWeight).map(([k, v]) => (
        <p key={k} className="font-sans text-2xl" style={{ fontWeight: v }}>
          <code className="mr-3 text-sm text-text-tertiary">
            {k} ({v})
          </code>
          {SAMPLE}
        </p>
      ))}
    </section>
  ),
};

export const LetterSpacing: Story = {
  render: () => (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-2xl font-semibold text-text-primary">Letter spacing</h2>
      {Object.entries(letterSpacing).map(([k, v]) => (
        <p key={k} className="font-display text-xl" style={{ letterSpacing: v }}>
          <code className="mr-3 text-sm text-text-tertiary">
            {k} ({v})
          </code>
          DIKTAT
        </p>
      ))}
    </section>
  ),
};
