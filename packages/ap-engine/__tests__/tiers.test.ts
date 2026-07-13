import { describe, expect, it } from 'vitest';
import { TIER_BANDS } from '../src/constants.js';
import { nextTierThreshold, tierFromAp, tierMeta } from '../src/tiers.js';

describe('tierFromAp', () => {
  it('returns 0 for AP=0', () => {
    expect(tierFromAp(0)).toBe(0);
  });

  it('lands on the higher band at every boundary', () => {
    for (let i = 1; i < TIER_BANDS.length; i++) {
      const band = TIER_BANDS[i]!;
      expect(tierFromAp(band.apMin)).toBe(band.id);
      expect(tierFromAp(band.apMin - 1)).toBe(TIER_BANDS[i - 1]!.id);
    }
  });

  it('returns Mythic for very large AP including MAX_SAFE_INTEGER', () => {
    expect(tierFromAp(75_000)).toBe(11);
    expect(tierFromAp(74_999)).toBe(10);
    expect(tierFromAp(120_000)).toBe(11); // open-top Mythic interior (ap_max is null)
    expect(tierFromAp(Number.MAX_SAFE_INTEGER)).toBe(11);
  });

  // Explicit crossing boundaries the settlement SQL band-lookup must mirror
  // 1:1 (migration 20260713120000). The 749->750 line is load-bearing: it is
  // where tiers.payout_eligible flips false->true (Partisan -> Operative), so
  // real payouts unlock exactly here.
  it('locks the exact crossing boundaries the SQL recompute mirrors', () => {
    expect(tierFromAp(0)).toBe(0);
    expect(tierFromAp(99)).toBe(0);
    expect(tierFromAp(100)).toBe(1);
    expect(tierFromAp(749)).toBe(2);
    expect(tierFromAp(750)).toBe(3); // payout_eligible flips true here
    expect(tierFromAp(74_999)).toBe(10);
    expect(tierFromAp(75_000)).toBe(11);
  });

  it('throws on negative or non-finite AP', () => {
    expect(() => tierFromAp(-1)).toThrow(RangeError);
    expect(() => tierFromAp(Number.NaN)).toThrow(RangeError);
    expect(() => tierFromAp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('nextTierThreshold', () => {
  it('returns the next band apMin for non-Mythic tiers', () => {
    expect(nextTierThreshold(0)).toBe(100);
    expect(nextTierThreshold(99)).toBe(100);
    expect(nextTierThreshold(100)).toBe(300);
    expect(nextTierThreshold(74_999)).toBe(75_000);
  });

  it('returns null at Mythic', () => {
    expect(nextTierThreshold(75_000)).toBeNull();
    expect(nextTierThreshold(1_000_000)).toBeNull();
  });
});

describe('tierMeta', () => {
  it('returns each band by id', () => {
    for (const band of TIER_BANDS) {
      expect(tierMeta(band.id)).toEqual(band);
    }
  });
});
