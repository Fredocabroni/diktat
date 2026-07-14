// Reduced-motion path — kept in its own file because framer-motion caches the
// prefers-reduced-motion value module-globally on first read. Vitest isolates
// modules per test file, so setting matchMedia to `reduce` here (before the
// first render) makes framer's useReducedMotion return true for this file only,
// without perturbing the animated-path assertions in TierUpAnimation.test.tsx.
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: true, // prefers-reduced-motion: reduce
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// Imported after the matchMedia override so framer reads it on first render.
const { TierUpAnimation } = await import('../src/components/tiers/TierUpAnimation.js');

afterEach(cleanup);

describe('TierUpAnimation (reduced motion)', () => {
  it('fires onComplete without waiting out the tierUp duration, and renders no particles', async () => {
    const onComplete = vi.fn();
    const { getByRole, container } = render(
      <TierUpAnimation fromTier={9} toTier={11} severity={4} onComplete={onComplete} />,
    );
    // Fires from the mount effect (severity-4 duration is 1600ms; this resolves
    // well under that), proving the reduced path short-circuits the timer.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(getByRole('status')).toHaveAttribute('data-reduced-motion', 'true');
    expect(container.querySelectorAll('[data-particle]')).toHaveLength(0);
  });
});
