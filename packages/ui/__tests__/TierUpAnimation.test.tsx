import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TierUpAnimation } from '../src/components/tiers/TierUpAnimation.js';

// jsdom has no matchMedia; framer-motion's useReducedMotion reads it. Mock it
// so both the animated and reduced-motion branches are exercised deterministically.
function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

afterEach(cleanup);

describe('TierUpAnimation', () => {
  it('mounts under its self-supplied LazyMotion without a context throw (m.* resolves)', () => {
    mockMatchMedia(false);
    const { getByRole } = render(<TierUpAnimation fromTier={2} toTier={3} severity={1} />);
    const el = getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('data-severity', '1');
  });

  it('renders graded particle counts (12 / 96) by severity', () => {
    mockMatchMedia(false);
    const { container, rerender } = render(
      <TierUpAnimation fromTier={0} toTier={1} severity={1} />,
    );
    expect(container.querySelectorAll('[data-particle]')).toHaveLength(12);
    rerender(<TierUpAnimation fromTier={9} toTier={11} severity={4} />);
    expect(container.querySelectorAll('[data-particle]')).toHaveLength(96);
  });
});
