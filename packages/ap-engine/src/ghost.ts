/**
 * Ghost USDC mint computation.
 *
 * The "ghost economy" lets brand-new users (tiers 0–2, the non-payout tiers)
 * see their wallet balance climb in dollars even though they're not yet
 * eligible for real payouts. It's a UX-teaching tool, not a real obligation.
 *
 * - Eligibility: tiers 0, 1, 2 only AND `apDelta > 0`.
 * - Currency unit: micros of USDC (`1_000_000n` = $1.00) to match the
 *   `wallets.usdc_balance_micro bigint` column. We use `bigint` end-to-end
 *   so a 9 quintillion micros ceiling is impossible to hit and JS-number
 *   precision loss never enters the picture.
 */

import type { Tier } from '@diktat/shared';
import { GHOST_USD_MICROS_PER_AP } from './constants.js';

export interface GhostInput {
  readonly tier: Tier;
  /** Final AP delta after ELO + protections. Only positive deltas mint. */
  readonly apDelta: number;
}

export interface GhostResult {
  readonly ghostUsdMicros: bigint;
  readonly eligible: boolean;
}

/**
 * Compute the ghost-USDC micros to credit for a winner.
 *
 * Returns `{ eligible: false, ghostUsdMicros: 0n }` for:
 *  - tiers 3+ (real-payout tiers; the wallet earns real USDC there, not ghost)
 *  - apDelta <= 0 (no win, no mint)
 *  - non-finite or non-integer apDelta (defensive — engine bug surface)
 */
export function computeGhostEarnings(input: GhostInput): GhostResult {
  const { tier, apDelta } = input;

  if (tier > 2) return { ghostUsdMicros: 0n, eligible: false };
  if (!Number.isFinite(apDelta) || !Number.isInteger(apDelta)) {
    return { ghostUsdMicros: 0n, eligible: false };
  }
  if (apDelta <= 0) return { ghostUsdMicros: 0n, eligible: false };

  const micros = BigInt(apDelta) * GHOST_USD_MICROS_PER_AP;
  return { ghostUsdMicros: micros, eligible: true };
}
