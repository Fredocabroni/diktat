/**
 * Pure battle settlement.
 *
 * Given a validated `BattleSettleInput`, produces the deterministic list of
 * `ApTransactionDraft`s that should be written to `ap_transactions`. Same
 * input → same drafts → same `idempotencyKey`s. The adapter (`db.ts`) does
 * the actual insert with `on conflict (idempotency_key) do nothing`, so
 * re-running this orchestrator is safe.
 *
 * Drafts emitted (for a `settled` 1v1 trivia/debate):
 *   - winner: `battle_win`
 *   - winner: `ghost_credit` (only when winner.tier ∈ {0,1,2})
 *   - loser:  `battle_loss`
 *
 * For `status === 'void'`, returns an empty list — no AP moves, no ghost
 * mint, nothing to write.
 *
 * NB: drafts do NOT carry `balanceAfter`. That field is computed inside the
 * adapter from a fresh `users.current_ap` read at write time, since the
 * orchestrator is pure and cannot know the live balance.
 */

import type { ApReason, BattleId, Tier, UserId } from '@diktat/shared';

import { computeApDelta } from './elo.js';
import { computeGhostEarnings } from './ghost.js';
import { applyLossStreakProtection, applyTierFloor } from './protections.js';
import type { BattleSettleInput } from './validators.js';

export interface ApTransactionDraft {
  readonly userId: UserId;
  /** Signed AP delta. Positive for credits, negative for losses. */
  readonly delta: number;
  /** Optional ghost-USDC mint (winners at tiers 0–2 only, in micros). */
  readonly ghostUsdMicros: bigint;
  readonly reason: ApReason;
  readonly refType: 'battle' | null;
  readonly refId: BattleId | null;
  readonly idempotencyKey: string;
}

/**
 * Build the deterministic idempotency key for one (battle, user, reason) tuple.
 * Stable across retries — the adapter relies on this to short-circuit dupes.
 */
export function idempotencyKeyFor(battleId: BattleId, userId: UserId, reason: ApReason): string {
  return `battle:${battleId}:user:${userId}:reason:${reason}`;
}

export function settleBattle(input: BattleSettleInput): ApTransactionDraft[] {
  if (input.status === 'void') return [];

  const { battleId, mode, winner, loser } = input;

  // 1) Raw ELO swing.
  const { winnerDelta: rawWinnerDelta, loserDelta: rawLoserDelta } = computeApDelta({
    winnerAp: winner.apBefore,
    loserAp: loser.apBefore,
    winnerTier: winner.tier,
    loserTier: loser.tier,
    mode,
  });

  // 2) Loser-side: loss-streak reduction first (operates on the magnitude),
  //    then tier floor (clamps based on resulting balance).
  const streakAdjusted = applyLossStreakProtection({
    rawLoss: rawLoserDelta,
    consecutiveLosses: loser.consecutiveLosses,
    reductionsUsed: loser.reductionsUsed,
  });

  const loserDeltaFinal = applyTierFloor({
    currentAp: loser.apBefore,
    tier: loser.tier,
    proposedDelta: streakAdjusted.adjustedLoss,
  });

  // 3) Winner-side: no protections, ghost mint maybe.
  const winnerDeltaFinal = rawWinnerDelta;
  const ghost = computeGhostEarnings({ tier: winner.tier, apDelta: winnerDeltaFinal });

  const drafts: ApTransactionDraft[] = [];

  // Winner: battle_win
  drafts.push({
    userId: winner.userId,
    delta: winnerDeltaFinal,
    ghostUsdMicros: 0n,
    reason: 'battle_win',
    refType: 'battle',
    refId: battleId,
    idempotencyKey: idempotencyKeyFor(battleId, winner.userId, 'battle_win'),
  });

  // Winner: ghost_credit (only when eligible)
  if (ghost.eligible && ghost.ghostUsdMicros > 0n) {
    drafts.push({
      userId: winner.userId,
      delta: 0,
      ghostUsdMicros: ghost.ghostUsdMicros,
      reason: 'ghost_credit',
      refType: 'battle',
      refId: battleId,
      idempotencyKey: idempotencyKeyFor(battleId, winner.userId, 'ghost_credit'),
    });
  }

  // Loser: battle_loss (always emit, even if delta clamped to 0 — keeps the
  // ledger trail honest and lets analytics see "loss faced, AP protected").
  drafts.push({
    userId: loser.userId,
    delta: loserDeltaFinal,
    ghostUsdMicros: 0n,
    reason: 'battle_loss',
    refType: 'battle',
    refId: battleId,
    idempotencyKey: idempotencyKeyFor(battleId, loser.userId, 'battle_loss'),
  });

  return drafts;
}

// Surface the input type so callers can `import type { Tier } ...` etc. without
// crossing a deep import. Tier kept here because settle drafts encode tier-derived effects.
export type { Tier };
