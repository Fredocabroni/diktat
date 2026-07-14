import { describe, expect, it } from 'vitest';

import { tierUpSeverity } from '../src/components/tiers/tierUpSeverity.js';

describe('tierUpSeverity', () => {
  it('single-step crossings take the destination band floor', () => {
    expect(tierUpSeverity(0, 1)).toBe(1); // Citizen -> Voter
    expect(tierUpSeverity(1, 2)).toBe(1); // Voter -> Partisan
    expect(tierUpSeverity(3, 4)).toBe(2); // -> Operative+ region (4)
    expect(tierUpSeverity(5, 6)).toBe(2); // still 4..6 band
    expect(tierUpSeverity(6, 7)).toBe(3); // -> Senator+ (7)
    expect(tierUpSeverity(8, 9)).toBe(3); // still 7..9 band
  });

  it('landing on tier 3 (payout unlock) floors to at least severity 2', () => {
    expect(tierUpSeverity(2, 3)).toBe(2); // single step to Operative — was 1, now floored
    expect(tierUpSeverity(1, 3)).toBe(2); // +2 jump: base 1 + 1 = 2, floor holds
    expect(tierUpSeverity(0, 3)).toBe(3); // +3 jump: base 1 + 2 = 3, above the floor
  });

  it('tier 10+ is always severity 4 (full ritual, §7)', () => {
    expect(tierUpSeverity(9, 10)).toBe(4); // Architect -> Legendary
    expect(tierUpSeverity(10, 11)).toBe(4); // Legendary -> Mythic
    expect(tierUpSeverity(0, 11)).toBe(4); // any jump that lands at Mythic
  });

  it('a bigger single-settlement jump bumps severity', () => {
    expect(tierUpSeverity(1, 2)).toBe(1); // +1, base 1
    expect(tierUpSeverity(0, 2)).toBe(2); // +2, base 1 + (2-1) = 2
    expect(tierUpSeverity(1, 4)).toBe(4); // base 2 + (3-1) = 4
    expect(tierUpSeverity(2, 5)).toBe(4); // base 2 + (3-1) = 4
    expect(tierUpSeverity(4, 7)).toBe(4); // base 3 + (3-1) = 5 -> clamp 4
  });

  it('never returns out of [1,4]', () => {
    for (let from = 0; from <= 11; from++) {
      for (let to = from; to <= 11; to++) {
        const s = tierUpSeverity(from as never, to as never);
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(4);
      }
    }
  });

  it('is pure — same inputs yield same output', () => {
    expect(tierUpSeverity(3, 6)).toBe(tierUpSeverity(3, 6));
  });
});
