/**
 * Loser-side protections:
 *  1. Loss-streak protection: after 3 consecutive losses, the next 2 losses
 *     are reduced by 30%. After both reductions are spent, full losses resume
 *     until the streak resets (caller's job — typically on a win).
 *  2. Tier floor: for tiers 0–6, a single loss cannot drop a user below the
 *     `apMin` of their current tier. Tiers 7+ are competitive ladders with
 *     no floor (matches the `floor_protected` column in the seed migration).
 */

import type { Tier } from '@diktat/shared';
import {
  LOSS_STREAK_REDUCTION,
  LOSS_STREAK_THRESHOLD,
  MAX_REDUCTIONS,
  TIER_FLOOR_LIMIT,
} from './constants.js';
import { tierMeta } from './tiers.js';

export interface LossStreakInput {
  /** The raw, ELO-derived loss as a non-positive integer (e.g. -32). */
  readonly rawLoss: number;
  /**
   * Number of consecutive losses *before* this one. The threshold check fires
   * when this is `>= LOSS_STREAK_THRESHOLD`, meaning losses 1..3 are full and
   * loss 4 is the first reduced one.
   */
  readonly consecutiveLosses: number;
  /** Number of reductions already applied during the current streak. */
  readonly reductionsUsed: number;
}

export interface LossStreakResult {
  readonly adjustedLoss: number;
  readonly reductionApplied: boolean;
}

/**
 * Apply loss-streak protection to a single loss event. Returns the adjusted
 * loss (still ≤ 0) and a flag indicating whether a reduction was consumed.
 *
 * Caller is responsible for incrementing `reductionsUsed` in their state when
 * `reductionApplied === true`, and for resetting both counters when the user
 * wins.
 */
export function applyLossStreakProtection(input: LossStreakInput): LossStreakResult {
  const { rawLoss, consecutiveLosses, reductionsUsed } = input;

  if (rawLoss > 0) {
    throw new RangeError(`applyLossStreakProtection: rawLoss must be <= 0, got ${rawLoss}`);
  }
  if (consecutiveLosses < 0 || reductionsUsed < 0) {
    throw new RangeError('applyLossStreakProtection: counters must be >= 0');
  }

  const eligible = consecutiveLosses >= LOSS_STREAK_THRESHOLD && reductionsUsed < MAX_REDUCTIONS;

  if (!eligible) {
    return { adjustedLoss: rawLoss, reductionApplied: false };
  }

  // 30% reduction → keep 70% of the loss magnitude. Round to integer; never
  // round past zero (a tiny loss should remain a loss, not a no-op).
  const reduced = rawLoss * (1 - LOSS_STREAK_REDUCTION);
  let adjusted = Math.round(reduced);
  if (adjusted === 0 && rawLoss < 0) adjusted = -1;

  return { adjustedLoss: adjusted, reductionApplied: true };
}

export interface TierFloorInput {
  readonly currentAp: number;
  readonly tier: Tier;
  /** Proposed delta from ELO + protections. Negative for a loss, 0 or positive otherwise. */
  readonly proposedDelta: number;
}

/**
 * Clamp a loss so the resulting AP cannot drop below the tier's `apMin`,
 * for tiers 0..6 (`floor_protected = true` in the seed). For tiers 7+, the
 * proposed delta is returned unchanged.
 *
 * Wins (delta > 0) are passed through. The clamped delta is still ≤ 0 — if
 * the user is already exactly at the floor, the function returns 0.
 */
export function applyTierFloor(input: TierFloorInput): number {
  const { currentAp, tier, proposedDelta } = input;

  if (proposedDelta >= 0) return proposedDelta;
  if (tier >= TIER_FLOOR_LIMIT) return proposedDelta;

  const floor = tierMeta(tier).apMin;
  const projected = currentAp + proposedDelta;

  if (projected >= floor) return proposedDelta;

  // Allow exactly the drop that lands the user on the floor; never go below.
  // If the user is already below the floor (shouldn't happen, but defend), return 0.
  const allowed = floor - currentAp;
  return allowed >= 0 ? 0 : allowed;
}
