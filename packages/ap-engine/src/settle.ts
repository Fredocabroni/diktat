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
  /**
   * True when this draft came from a battle where at least one participant
   * was a bot. Practice drafts trigger the 200/day cap inside the
   * apply_ap_drafts SQL function (migration 0013).
   */
  readonly isPractice: boolean;
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

  const { battleId, mode, winner, loser, isPractice } = input;

  // #127 H1 — bot-vs-bot is impossible by construction: matchmake.ts:188
  // (`allowBotFallback = mode === 'trivia'`) plus the seeker-is-from-queue
  // invariant means the fallback pairs exactly one bot against one human
  // seeker. If both participants are bots, something upstream is
  // catastrophically broken — a settled battle with no ap ledger rows
  // would also trip the Q1 invariant monitor
  // (apps/workers/src/jobs/invariant-check.ts battle_settled_missing_ap).
  // Fail loudly with a specific error so the caller surfaces it via the
  // handler's Telegram alert path rather than silently returning [] and
  // letting the battle land as settled with no drafts.
  //
  // Round-2 security-reviewer M3 on #139: don't `return []` on bot-vs-bot.
  if (winner.isBot && loser.isBot) {
    throw new Error(
      `settleBattle: bot-vs-bot battle ${battleId} is impossible by construction ` +
        `(matchmake.ts:188 restricts bot fallback to trivia + seeker-from-queue). ` +
        `Refusing to settle with zero AP drafts, which would also trip Q1.`,
    );
  }

  // 1) Raw ELO swing.
  const { winnerDelta: rawWinnerDelta, loserDelta: rawLoserDelta } = computeApDelta({
    winnerAp: winner.apBefore,
    loserAp: loser.apBefore,
    winnerTier: winner.tier,
    loserTier: loser.tier,
    mode,
  });

  // 2) Loser-side: loss-streak reduction first (operates on the magnitude),
  //    then tier floor (clamps based on resulting balance). Practice
  //    matches zero out the loss entirely — losing to a bot must never
  //    take real AP.
  let loserDeltaFinal: number;
  if (isPractice) {
    loserDeltaFinal = 0;
  } else {
    const streakAdjusted = applyLossStreakProtection({
      rawLoss: rawLoserDelta,
      consecutiveLosses: loser.consecutiveLosses,
      reductionsUsed: loser.reductionsUsed,
    });
    loserDeltaFinal = applyTierFloor({
      currentAp: loser.apBefore,
      tier: loser.tier,
      proposedDelta: streakAdjusted.adjustedLoss,
    });
  }

  // 3) Winner-side: practice halves the credit (the SQL function further
  //    enforces a 200/day cap). Ghost-USD mint stays gated by tier — a
  //    practice win at tier 0–2 still mints ghost dollars, since "what
  //    you'd earn if real" is the whole point of the ghost ledger.
  //
  // Bot guard sits BEFORE computeGhostEarnings (round-2 security-reviewer
  // M1 on #139). Bots never carry rows in ap_transactions, so the ghost
  // compute is dead work when the winner is a bot — skip it entirely to
  // avoid computing a value we would immediately discard.
  const winnerDeltaPreCap = isPractice ? Math.floor(rawWinnerDelta / 2) : rawWinnerDelta;

  const drafts: ApTransactionDraft[] = [];

  // #127 H1 — bot-win AP inflation. Bots must never carry rows in
  // `ap_transactions`. If the winner is a bot, drop the battle_win +
  // ghost_credit drafts. If the loser is a bot, drop the battle_loss
  // draft. Bot-vs-bot is rejected above. The invariant Q1 (see
  // apps/workers/src/jobs/invariant-check.ts battle_settled_missing_ap)
  // requires at least one ledger row per settled battle keyed by
  // ref_type='battle', ref_id=battleId — this remains true whenever
  // at least one participant is a human, which the bot-vs-bot throw
  // above enforces.
  //
  // Winner: battle_win (skipped for bot winners)
  if (!winner.isBot) {
    const ghost = computeGhostEarnings({ tier: winner.tier, apDelta: winnerDeltaPreCap });
    drafts.push({
      userId: winner.userId,
      delta: winnerDeltaPreCap,
      ghostUsdMicros: 0n,
      reason: 'battle_win',
      refType: 'battle',
      refId: battleId,
      idempotencyKey: idempotencyKeyFor(battleId, winner.userId, 'battle_win'),
      isPractice,
    });

    // Winner: ghost_credit (only when eligible AND winner is human)
    if (ghost.eligible && ghost.ghostUsdMicros > 0n) {
      drafts.push({
        userId: winner.userId,
        delta: 0,
        ghostUsdMicros: ghost.ghostUsdMicros,
        reason: 'ghost_credit',
        refType: 'battle',
        refId: battleId,
        idempotencyKey: idempotencyKeyFor(battleId, winner.userId, 'ghost_credit'),
        isPractice,
      });
    }
  }

  // Loser: battle_loss (skipped for bot losers). Always emit for humans
  // even if delta clamped to 0 — keeps the ledger trail honest and lets
  // analytics see "loss faced, AP protected".
  if (!loser.isBot) {
    drafts.push({
      userId: loser.userId,
      delta: loserDeltaFinal,
      ghostUsdMicros: 0n,
      reason: 'battle_loss',
      refType: 'battle',
      refId: battleId,
      idempotencyKey: idempotencyKeyFor(battleId, loser.userId, 'battle_loss'),
      isPractice,
    });
  }

  return drafts;
}

// Surface the input type so callers can `import type { Tier } ...` etc. without
// crossing a deep import. Tier kept here because settle drafts encode tier-derived effects.
export type { Tier };
