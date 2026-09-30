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
  isPractice: false,
  winner: { userId: WINNER, apBefore: 2000, tier: 4, isBot: false },
  loser: {
    userId: LOSER,
    apBefore: 2000,
    tier: 4,
    consecutiveLosses: 0,
    reductionsUsed: 0,
    isBot: false,
  },
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
        winner: { userId: WINNER, apBefore: 50, tier: 0, isBot: false },
        loser: {
          userId: LOSER,
          apBefore: 50,
          tier: 0,
          consecutiveLosses: 0,
          reductionsUsed: 0,
          isBot: false,
        },
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

  it('halves the winner delta and zeros the loser delta when isPractice=true', () => {
    const real = settleBattle(baseInput());
    const practice = settleBattle(baseInput({ isPractice: true }));

    const realWin = real.find((d) => d.reason === 'battle_win')!;
    const practiceWin = practice.find((d) => d.reason === 'battle_win')!;
    const practiceLoss = practice.find((d) => d.reason === 'battle_loss')!;

    expect(practiceWin.delta).toBe(Math.floor(realWin.delta / 2));
    expect(practiceLoss.delta).toBe(0);
    expect(practiceWin.isPractice).toBe(true);
    expect(practiceLoss.isPractice).toBe(true);
    expect(realWin.isPractice).toBe(false);
  });

  // #127 H1 — bot-win AP inflation. Bots must never carry rows in
  // ap_transactions. The invariant Q1 (battle_settled_missing_ap) still
  // requires at least one row per settled battle keyed on
  // (ref_type='battle', ref_id=battleId) — which is preserved because
  // matchmaking never produces bot-vs-bot (see settle.ts header).
  describe('#127 H1 — bot-win AP inflation', () => {
    it('skips both winner drafts when the winner is a bot; keeps human loser battle_loss (zero-delta under isPractice)', () => {
      const drafts = settleBattle(
        baseInput({
          isPractice: true,
          winner: { userId: WINNER, apBefore: 50, tier: 0, isBot: true },
          loser: {
            userId: LOSER,
            apBefore: 50,
            tier: 0,
            consecutiveLosses: 0,
            reductionsUsed: 0,
            isBot: false,
          },
        }),
      );

      // Only one row: the human loser's zero-delta battle_loss.
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.reason).toBe('battle_loss');
      expect(drafts[0]!.userId).toBe(LOSER);
      expect(drafts[0]!.delta).toBe(0);
      // No battle_win / ghost_credit for the bot user under any reason.
      expect(drafts.find((d) => d.userId === WINNER)).toBeUndefined();
    });

    it('skips loser draft when the loser is a bot; keeps human winner battle_win', () => {
      // Human seeker beat a fallback bot. Human's battle_win emitted.
      // No battle_loss for the bot.
      const drafts = settleBattle(
        baseInput({
          isPractice: true,
          winner: { userId: WINNER, apBefore: 2000, tier: 4, isBot: false },
          loser: {
            userId: LOSER,
            apBefore: 2000,
            tier: 4,
            consecutiveLosses: 0,
            reductionsUsed: 0,
            isBot: true,
          },
        }),
      );

      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.reason).toBe('battle_win');
      expect(drafts[0]!.userId).toBe(WINNER);
      // No draft for the bot loser under any reason.
      expect(drafts.find((d) => d.userId === LOSER)).toBeUndefined();
    });

    it('bot-vs-bot returns zero drafts (defensive — matchmake prevents this shape)', () => {
      const drafts = settleBattle(
        baseInput({
          isPractice: true,
          winner: { userId: WINNER, apBefore: 2000, tier: 4, isBot: true },
          loser: {
            userId: LOSER,
            apBefore: 2000,
            tier: 4,
            consecutiveLosses: 0,
            reductionsUsed: 0,
            isBot: true,
          },
        }),
      );
      expect(drafts).toEqual([]);
    });
  });
});
