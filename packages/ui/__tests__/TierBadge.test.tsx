import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { TierBadge } from '../src/components/tiers/TierBadge.js';
import { TIERS } from '../src/components/tiers/tiers.config.js';
import { tier as tierTokens } from '../src/tokens/colors.js';
import type { TierNumber, TierSize } from '../src/components/tiers/TierBadge.types.js';

const SIZES: TierSize[] = ['sm', 'md', 'lg', 'xl'];

interface MatchMediaSetup {
  reduce: boolean;
}

function mockMatchMedia({ reduce }: MatchMediaSetup): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('reduce') ? reduce : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  mockMatchMedia({ reduce: false });
});

afterEach(() => {
  cleanup();
});

describe('TierBadge — args matrix snapshots (12 tiers × 4 sizes)', () => {
  describe.each(TIERS.map((t) => [t.tier, t.name]))('tier %i (%s)', (tier, name) => {
    it.each(SIZES)('renders at size=%s with role=img', (size) => {
      const { container } = render(<TierBadge tier={tier as TierNumber} size={size as TierSize} />);
      const root = container.querySelector('[role="img"]');
      expect(root).not.toBeNull();
      expect(root!.getAttribute('aria-label')).toMatch(new RegExp(name as string));
      expect(root!.getAttribute('data-tier')).toBe(String(tier));
      expect(root!.getAttribute('data-size')).toBe(size);
    });
  });
});

describe('TierBadge — locked state', () => {
  it('sets aria-disabled when locked', () => {
    render(<TierBadge tier={5} locked />);
    const root = screen.getByRole('img');
    expect(root.getAttribute('aria-disabled')).toBe('true');
    expect(root.getAttribute('aria-label')).toMatch(/locked/i);
  });

  it('does not set aria-disabled when unlocked', () => {
    render(<TierBadge tier={5} />);
    const root = screen.getByRole('img');
    expect(root.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('TierBadge — glow respects prefers-reduced-motion', () => {
  it('applies glow data attribute when motion is allowed', () => {
    mockMatchMedia({ reduce: false });
    render(<TierBadge tier={6} glow />);
    const root = screen.getByRole('img');
    expect(root.getAttribute('data-glow')).toBe('true');
  });

  it('suppresses glow under prefers-reduced-motion', () => {
    mockMatchMedia({ reduce: true });
    render(<TierBadge tier={6} glow />);
    const root = screen.getByRole('img');
    expect(root.getAttribute('data-glow')).toBeNull();
  });
});

describe('TierBadge — Mythic gradient gating', () => {
  it('marks data-mythic on tier 11', () => {
    render(<TierBadge tier={11} />);
    const root = screen.getByRole('img');
    expect(root.getAttribute('data-mythic')).toBe('true');
  });

  it('does not mark data-mythic on lower tiers', () => {
    render(<TierBadge tier={10} />);
    const root = screen.getByRole('img');
    expect(root.getAttribute('data-mythic')).toBeNull();
  });
});

describe('TierBadge — labels', () => {
  it('renders the tier name when showLabel=true', () => {
    render(<TierBadge tier={3} showLabel />);
    expect(screen.getByText('Operative')).toBeTruthy();
  });

  it('omits the name when showLabel is unset', () => {
    render(<TierBadge tier={3} />);
    expect(screen.queryByText('Operative')).toBeNull();
  });

  it('honors a custom ariaLabel override', () => {
    render(<TierBadge tier={4} ariaLabel="custom label" />);
    expect(screen.getByLabelText('custom label')).toBeTruthy();
  });
});

describe('TierBadge — WCAG contrast: tiers with light backgrounds use dark fg', () => {
  it.each([4, 10, 11])('tier %i palette uses dark foreground (ink.900-ish)', (n) => {
    const palette = tierTokens[`t${n}` as keyof typeof tierTokens];
    expect(palette.fg).toMatch(/^#[0-3]/i);
  });

  it.each([0, 1, 2, 3, 5, 6, 7, 8, 9])('tier %i palette uses light foreground', (n) => {
    const palette = tierTokens[`t${n}` as keyof typeof tierTokens];
    expect(palette.fg).toMatch(/^#[E-Ff]/i);
  });
});
