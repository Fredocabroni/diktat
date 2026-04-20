import { describe, expect, it } from 'vitest';
import { applyLossStreakProtection, applyTierFloor } from '../src/protections.js';

describe('applyLossStreakProtection', () => {
  it('does not reduce losses 1–3', () => {
    for (let i = 0; i < 3; i++) {
      const r = applyLossStreakProtection({
        rawLoss: -50,
        consecutiveLosses: i,
        reductionsUsed: 0,
      });
      expect(r.adjustedLoss).toBe(-50);
      expect(r.reductionApplied).toBe(false);
    }
  });

  it('reduces loss 4 by 30% (the first reduction)', () => {
    const r = applyLossStreakProtection({
      rawLoss: -50,
      consecutiveLosses: 3,
      reductionsUsed: 0,
    });
    expect(r.reductionApplied).toBe(true);
    expect(r.adjustedLoss).toBe(-35);
  });

  it('reduces loss 5 (the second + final reduction)', () => {
    const r = applyLossStreakProtection({
      rawLoss: -50,
      consecutiveLosses: 4,
      reductionsUsed: 1,
    });
    expect(r.reductionApplied).toBe(true);
    expect(r.adjustedLoss).toBe(-35);
  });

  it('returns full loss on loss 6 (reductions exhausted)', () => {
    const r = applyLossStreakProtection({
      rawLoss: -50,
      consecutiveLosses: 5,
      reductionsUsed: 2,
    });
    expect(r.reductionApplied).toBe(false);
    expect(r.adjustedLoss).toBe(-50);
  });

  it('throws on positive rawLoss or negative counters', () => {
    expect(() =>
      applyLossStreakProtection({ rawLoss: 5, consecutiveLosses: 0, reductionsUsed: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      applyLossStreakProtection({ rawLoss: -5, consecutiveLosses: -1, reductionsUsed: 0 }),
    ).toThrow(RangeError);
  });

  it('never rounds a loss away to zero', () => {
    const r = applyLossStreakProtection({
      rawLoss: -1,
      consecutiveLosses: 3,
      reductionsUsed: 0,
    });
    expect(r.adjustedLoss).toBeLessThan(0);
  });
});

describe('applyTierFloor', () => {
  it('floors a tier-3 user (750 floor) to 0 delta when sitting exactly on the floor', () => {
    const allowed = applyTierFloor({ currentAp: 750, tier: 3, proposedDelta: -50 });
    expect(allowed).toBe(0);
  });

  it('clamps to the exact distance to the floor', () => {
    // currentAp 780, tier 3 (floor 750), proposed -100 → allowed -30.
    const allowed = applyTierFloor({ currentAp: 780, tier: 3, proposedDelta: -100 });
    expect(allowed).toBe(-30);
  });

  it('does not clamp losses for tier-7 (no floor protection)', () => {
    const allowed = applyTierFloor({ currentAp: 10_000, tier: 7, proposedDelta: -50 });
    expect(allowed).toBe(-50);
  });

  it('passes through wins unchanged', () => {
    const allowed = applyTierFloor({ currentAp: 1500, tier: 3, proposedDelta: 25 });
    expect(allowed).toBe(25);
  });
});
