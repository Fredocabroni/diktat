import { describe, expect, it } from 'vitest';
import { MAX_DELTA_CAP, MIN_DELTA_FLOOR } from '../src/constants.js';
import { computeApDelta, expectedScore } from '../src/elo.js';

describe('expectedScore', () => {
  it('is 0.5 for equal ratings', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 5);
  });

  it('is symmetric: e(a,b) + e(b,a) = 1', () => {
    expect(expectedScore(1500, 1900) + expectedScore(1900, 1500)).toBeCloseTo(1, 5);
  });
});

describe('computeApDelta', () => {
  it('produces equal-magnitude deltas for a symmetric matchup', () => {
    const r = computeApDelta({
      winnerAp: 1500,
      loserAp: 1500,
      winnerTier: 4,
      loserTier: 4,
      mode: 'trivia',
    });
    expect(r.winnerDelta).toBe(-r.loserDelta);
  });

  it('rewards an upset more than a favorite-win (lower-AP winner = larger delta)', () => {
    const upset = computeApDelta({
      winnerAp: 1500,
      loserAp: 1900,
      winnerTier: 4,
      loserTier: 4,
      mode: 'trivia',
    });
    const favorite = computeApDelta({
      winnerAp: 1900,
      loserAp: 1500,
      winnerTier: 4,
      loserTier: 4,
      mode: 'trivia',
    });
    expect(upset.winnerDelta).toBeGreaterThan(favorite.winnerDelta);
  });

  it('uses the higher tier’s K-factor (anchor rule)', () => {
    // Same matchup at very different tiers — the anchor (max tier) sets K.
    const lowAnchor = computeApDelta({
      winnerAp: 1500,
      loserAp: 1500,
      winnerTier: 0,
      loserTier: 0,
      mode: 'trivia',
    });
    const highAnchor = computeApDelta({
      winnerAp: 1500,
      loserAp: 1500,
      winnerTier: 11,
      loserTier: 11,
      mode: 'trivia',
    });
    expect(lowAnchor.winnerDelta).toBeGreaterThan(highAnchor.winnerDelta);
  });

  it('caps at MAX_DELTA_CAP for blowouts', () => {
    const r = computeApDelta({
      winnerAp: 100,
      loserAp: 5000,
      winnerTier: 0,
      loserTier: 5,
      mode: 'trivia',
    });
    expect(r.winnerDelta).toBeLessThanOrEqual(MAX_DELTA_CAP);
  });

  it('floors at MIN_DELTA_FLOOR for near-ties', () => {
    const r = computeApDelta({
      winnerAp: 75_000,
      loserAp: 75_000,
      winnerTier: 11,
      loserTier: 11,
      mode: 'trivia',
    });
    expect(r.winnerDelta).toBeGreaterThanOrEqual(MIN_DELTA_FLOOR);
  });
});
