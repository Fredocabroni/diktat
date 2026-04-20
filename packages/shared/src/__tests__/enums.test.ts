import { describe, expect, it } from 'vitest';
import {
  ApReasonSchema,
  BattleModeSchema,
  OpinionPositionSchema,
  TIER_IDS,
  TierSchema,
} from '../enums.js';

describe('enums', () => {
  it('TIER_IDS covers 0..11 in order', () => {
    expect(TIER_IDS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('TierSchema accepts all 12 tiers and rejects 12', () => {
    for (const t of TIER_IDS) {
      expect(TierSchema.parse(t)).toBe(t);
    }
    expect(() => TierSchema.parse(12)).toThrow();
    expect(() => TierSchema.parse(-1)).toThrow();
  });

  it('BattleModeSchema accepts the three modes only', () => {
    expect(BattleModeSchema.parse('trivia')).toBe('trivia');
    expect(() => BattleModeSchema.parse('boxing')).toThrow();
  });

  it('ApReasonSchema accepts all reasons', () => {
    for (const r of [
      'battle_win',
      'battle_loss',
      'prediction_settle',
      'ghost_credit',
      'streak_bonus',
      'admin_adjust',
    ]) {
      expect(ApReasonSchema.parse(r)).toBe(r);
    }
  });

  it('OpinionPositionSchema clamps to -2..2', () => {
    expect(OpinionPositionSchema.parse(0)).toBe(0);
    expect(OpinionPositionSchema.parse(-2)).toBe(-2);
    expect(OpinionPositionSchema.parse(2)).toBe(2);
    expect(() => OpinionPositionSchema.parse(3)).toThrow();
  });
});
