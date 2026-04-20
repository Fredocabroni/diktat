import type { Meta, StoryObj } from '@storybook/react';

import { brand, ink, paper, semantic, surface, text, tier } from './colors.js';

type Swatch = { label: string; value: string; path: string };

function Chip({ label, value, path }: Swatch) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink-300 bg-ink-100 p-3">
      <div
        className="h-16 w-full rounded-md border border-black/40"
        style={{ background: value }}
        aria-label={`${path} swatch`}
      />
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        <code className="text-xs text-text-tertiary">{path}</code>
        <code className="text-xs text-text-secondary">{value}</code>
      </div>
    </div>
  );
}

function Section({ title, swatches }: { title: string; swatches: Swatch[] }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-2xl font-semibold text-text-primary">{title}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {swatches.map((s) => (
          <Chip key={s.path} {...s} />
        ))}
      </div>
    </section>
  );
}

function TierChip({
  label,
  base,
  ring,
  fg,
  glowFrom,
  glowTo,
  path,
}: {
  label: string;
  base: string;
  ring: string;
  fg: string;
  glowFrom: string;
  glowTo: string;
  path: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-ink-300 bg-ink-100 p-4">
      <div
        className="flex h-20 w-20 items-center justify-center rounded-full text-sm font-bold"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${glowFrom}, ${glowTo})`,
          color: fg,
          border: `2px solid ${ring}`,
          boxShadow: `0 0 18px 2px ${glowFrom}80`,
        }}
        aria-label={`${path} preview`}
      >
        {label.toUpperCase()}
      </div>
      <div className="flex flex-col items-center gap-1">
        <code className="text-xs text-text-tertiary">{path}</code>
        <code className="text-xs text-text-secondary">base {base}</code>
      </div>
    </div>
  );
}

const meta: Meta = {
  title: 'Tokens/Colors',
};

export default meta;

type Story = StoryObj;

export const Brand: Story = {
  render: () => (
    <Section
      title="Brand"
      swatches={[
        { label: 'primary', value: brand.primary, path: 'brand.primary' },
        {
          label: 'primaryFg',
          value: brand.primaryFg,
          path: 'brand.primaryFg',
        },
        { label: 'accent', value: brand.accent, path: 'brand.accent' },
        { label: 'accentFg', value: brand.accentFg, path: 'brand.accentFg' },
      ]}
    />
  ),
};

export const Ink: Story = {
  render: () => (
    <Section
      title="Ink (12-stop, dark-first)"
      swatches={Object.entries(ink).map(([k, v]) => ({
        label: `ink.${k}`,
        value: v,
        path: `ink.${k}`,
      }))}
    />
  ),
};

export const Paper: Story = {
  render: () => (
    <Section
      title="Paper (12-stop, light-first)"
      swatches={Object.entries(paper).map(([k, v]) => ({
        label: `paper.${k}`,
        value: v,
        path: `paper.${k}`,
      }))}
    />
  ),
};

export const Semantic: Story = {
  render: () => (
    <Section
      title="Semantic"
      swatches={Object.entries(semantic).flatMap(([name, group]) =>
        Object.entries(group).map(([slot, value]) => ({
          label: `${name}.${slot}`,
          value: value as string,
          path: `semantic.${name}.${slot}`,
        })),
      )}
    />
  ),
};

export const Surface: Story = {
  render: () => (
    <Section
      title="Surface"
      swatches={Object.entries(surface).map(([k, v]) => ({
        label: `surface.${k}`,
        value: v,
        path: `surface.${k}`,
      }))}
    />
  ),
};

export const Text: Story = {
  render: () => (
    <Section
      title="Text"
      swatches={Object.entries(text).map(([k, v]) => ({
        label: `text.${k}`,
        value: v,
        path: `text.${k}`,
      }))}
    />
  ),
};

export const TierLadder: Story = {
  render: () => (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-2xl font-semibold text-text-primary">
        Tier Ladder (t0 → t11)
      </h2>
      <p className="max-w-2xl text-sm text-text-secondary">
        Single source of truth for the 12 tier badges. Cold slate at t0, violet/teal warm-up around
        t6, gold at t10, holographic at t11. Tiers 4, 10, 11 use dark fg for WCAG AA contrast.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {Object.entries(tier).map(([key, t]) => (
          <TierChip
            key={key}
            label={key}
            base={t.base}
            ring={t.ring}
            fg={t.fg}
            glowFrom={t.glowFrom}
            glowTo={t.glowTo}
            path={`tier.${key}`}
          />
        ))}
      </div>
    </section>
  ),
};
