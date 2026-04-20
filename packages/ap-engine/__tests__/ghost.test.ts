import { describe, expect, it } from 'vitest';
import { GHOST_USD_MICROS_PER_AP } from '../src/constants.js';
import { computeGhostEarnings } from '../src/ghost.js';

describe('computeGhostEarnings', () => {
  it('mints micros for a positive AP delta at tiers 0–2', () => {
    for (const tier of [0, 1, 2] as const) {
      const r = computeGhostEarnings({ tier, apDelta: 50 });
      expect(r.eligible).toBe(true);
      expect(r.ghostUsdMicros).toBe(BigInt(50) * GHOST_USD_MICROS_PER_AP);
    }
  });

  it('returns zero + ineligible for tiers 3–11', () => {
    for (const tier of [3, 6, 9, 11] as const) {
      const r = computeGhostEarnings({ tier, apDelta: 50 });
      expect(r.eligible).toBe(false);
      expect(r.ghostUsdMicros).toBe(0n);
    }
  });

  it('returns zero on a non-positive delta', () => {
    expect(computeGhostEarnings({ tier: 0, apDelta: 0 }).eligible).toBe(false);
    expect(computeGhostEarnings({ tier: 0, apDelta: -5 }).eligible).toBe(false);
  });

  it('rejects non-integer or non-finite deltas defensively', () => {
    expect(computeGhostEarnings({ tier: 0, apDelta: 1.5 }).eligible).toBe(false);
    expect(computeGhostEarnings({ tier: 0, apDelta: Number.NaN }).eligible).toBe(false);
  });
});
