import { battleId, userId } from '@diktat/shared';
import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor, settleBattle } from '../src/settle.js';
import type { BattleSettleInput } from '../src/validators.js';

const BID = battleId('11111111-1111-4111-8111-111111111111');
const WINNER = userId('22222222-2222-4222-8222-222222222222');
const LOSER = userId('33333333-3333-4333-8333-333333333333');

// Both players seated above the tier-4 floor (1500) so the loss is not clamped
// to zero by tier-floor protection in the happy-path test.
const baseInput = (overrides: Partial<BattleSettleInput> = {}): BattleSettleInput => ({
  battleId: BID,
  mode: 'trivia',
  status: 'settled',
  winner: { userId: WINNER, apBefore: 2000, tier: 4 },
  loser: { userId: LOSER, apBefore: 2000, tier: 4, consecutiveLosses: 0, reductionsUsed: 0 },
  ...overrides,
});

describe('settleBattle', () => {
  it('emits battle_win + battle_loss for a clean 1v1', () => {
    const drafts = settleBattle(baseInput());
    expect(drafts).toHaveLength(2);
    const [win, loss] = drafts;
    expect(win!.reason).toBe('battle_win');
    expect(win!.userId).toBe(WINNER);
    expect(win!.delta).toBeGreaterThan(0);
    expect(loss!.reason).toBe('battle_loss');
    expect(loss!.userId).toBe(LOSER);
    expect(loss!.delta).toBeLessThan(0);
  });

  it('adds ghost_credit when winner is at a non-payout tier (0–2)', () => {
    const drafts = settleBattle(
      baseInput({
        winner: { userId: WINNER, apBefore: 50, tier: 0 },
        loser: { userId: LOSER, apBefore: 50, tier: 0, consecutiveLosses: 0, reductionsUsed: 0 },
      }),
    );
    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => d.reason)).toEqual(['battle_win', 'ghost_credit', 'battle_loss']);
    expect(drafts[1]!.ghostUsdMicros).toBeGreaterThan(0n);
  });

  it('omits ghost_credit at payout tiers (3+)', () => {
    const drafts = settleBattle(baseInput());
    expect(drafts.find((d) => d.reason === 'ghost_credit')).toBeUndefined();
  });

  it('returns empty drafts for a void battle', () => {
    const drafts = settleBattle(baseInput({ status: 'void' }));
    expect(drafts).toEqual([]);
  });

  it('is deterministic: same input → same idempotency keys', () => {
    const a = settleBattle(baseInput());
    const b = settleBattle(baseInput());
    expect(a.map((d) => d.idempotencyKey)).toEqual(b.map((d) => d.idempotencyKey));
  });

  it('keys follow the documented battle:user:reason format', () => {
    const drafts = settleBattle(baseInput());
    expect(drafts[0]!.idempotencyKey).toBe(idempotencyKeyFor(BID, WINNER, 'battle_win'));
    expect(drafts[1]!.idempotencyKey).toBe(idempotencyKeyFor(BID, LOSER, 'battle_loss'));
  });
});
