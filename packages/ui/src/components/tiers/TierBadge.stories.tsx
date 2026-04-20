import type { Meta, StoryObj } from '@storybook/react';

import { TierBadge } from './TierBadge.js';
import { TIERS } from './tiers.config.js';
import { TierUpAnimation } from './TierUpAnimation.js';
import type { TierNumber, TierSize } from './TierBadge.types.js';

const meta: Meta<typeof TierBadge> = {
  title: 'Tiers/TierBadge',
  component: TierBadge,
  args: {
    tier: 4,
    size: 'lg',
    glow: false,
    locked: false,
    showLabel: false,
  },
  argTypes: {
    tier: { control: { type: 'number', min: 0, max: 11 } },
    size: { control: { type: 'select' }, options: ['sm', 'md', 'lg', 'xl'] },
  },
};

export default meta;
type Story = StoryObj<typeof TierBadge>;

export const Default: Story = {};

export const Locked: Story = {
  args: { tier: 7, locked: true, showLabel: true },
};

export const Glow: Story = {
  args: { tier: 6, glow: true, showLabel: true },
};

export const MythicHolo: Story = {
  args: { tier: 11, size: 'xl', glow: true, showLabel: true },
};

const SIZES: TierSize[] = ['sm', 'md', 'lg', 'xl'];

export const Matrix: Story = {
  parameters: { controls: { hideNoControlsWarning: true } },
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      {TIERS.map((entry) => (
        <div
          key={entry.tier}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(120px, max-content) repeat(4, max-content)',
            alignItems: 'center',
            gap: 24,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display, system-ui)',
              fontWeight: 600,
              color: 'var(--color-text-primary, #f2f2f7)',
            }}
          >
            t{entry.tier} · {entry.name}
          </span>
          {SIZES.map((size) => (
            <TierBadge key={size} tier={entry.tier as TierNumber} size={size} />
          ))}
        </div>
      ))}
    </div>
  ),
};

export const Ladder: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      {TIERS.map((entry) => (
        <TierBadge key={entry.tier} tier={entry.tier as TierNumber} size="lg" showLabel />
      ))}
    </div>
  ),
};

export const TierUpDemo: StoryObj = {
  name: 'TierUpAnimation/Severity Matrix',
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      {[1, 2, 3, 4].map((s) => (
        <TierUpAnimation key={s} fromTier={3} toTier={4} severity={s as 1 | 2 | 3 | 4} />
      ))}
    </div>
  ),
};
