/**
 * ELO-style AP delta calculation.
 *
 * Departures from textbook ELO:
 *  - K-factor is chosen by the **higher** of the two players' tiers. Rationale:
 *    the more established player is the stable anchor; using their (lower) K
 *    means an unranked challenger does not yo-yo a Senator's score with one
 *    upset. Documented in `docs/MASTER_PLAN.md` (AP curve section).
 *  - Result is rounded to integer, then capped at `MAX_DELTA_CAP` and floored
 *    at `MIN_DELTA_FLOOR` so wins always reward at least +5 / losses always
 *    bite at least -5.
 *  - The `mode` parameter is reserved for per-mode multipliers (debate vs.
 *    trivia) — currently unused but accepted to keep the call-site stable.
 */

import type { BattleMode, Tier } from '@diktat/shared';
import { K_FACTORS_BY_TIER, MAX_DELTA_CAP, MIN_DELTA_FLOOR } from './constants.js';

export interface ComputeApDeltaInput {
  readonly winnerAp: number;
  readonly loserAp: number;
  readonly winnerTier: Tier;
  readonly loserTier: Tier;
  readonly mode: BattleMode;
}

export interface ApDeltaResult {
  readonly winnerDelta: number;
  readonly loserDelta: number;
}

/**
 * Standard ELO expected-score formula. Returns the probability in `[0, 1]`
 * that player A beats player B given their ratings.
 */
export function expectedScore(rA: number, rB: number): number {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

/**
 * Compute the AP delta for a 1v1 battle that has a clear winner and loser.
 *
 * Returns INTEGER deltas, capped + floored. The winner gets a positive value,
 * the loser gets a negative value of equal magnitude (the magnitude itself is
 * bounded by `[MIN_DELTA_FLOOR, MAX_DELTA_CAP]`).
 */
export function computeApDelta(input: ComputeApDeltaInput): ApDeltaResult {
  const { winnerAp, loserAp, winnerTier, loserTier, mode: _mode } = input;

  // Use the higher tier's K so an established player's score is the anchor.
  const anchorTier: Tier = winnerTier >= loserTier ? winnerTier : loserTier;
  const k = K_FACTORS_BY_TIER[anchorTier];

  // The winner scored 1.0; their expected score is `expectedScore(winner, loser)`.
  const expectedWinner = expectedScore(winnerAp, loserAp);
  const rawDelta = k * (1 - expectedWinner);

  // Round to integer first so cap/floor are computed on the integer magnitude.
  let magnitude = Math.round(rawDelta);
  if (magnitude < MIN_DELTA_FLOOR) magnitude = MIN_DELTA_FLOOR;
  if (magnitude > MAX_DELTA_CAP) magnitude = MAX_DELTA_CAP;

  return {
    winnerDelta: magnitude,
    loserDelta: -magnitude,
  };
}
