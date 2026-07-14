// Maps a tier crossing (fromTier -> toTier) to a celebration severity 1..4.
// Severity drives both the celebration duration (motion.duration.tierUp[sev-1])
// and the particle count in TierUpAnimation.
//
// Policy (docs/ADDICTION_ARCHITECTURE.md §7):
//   - Reaching tier 10+ (Legendary / Mythic) is ALWAYS the full ritual (4).
//   - Otherwise a band floor by the destination tier, bumped by how many tiers
//     were jumped in a single settlement (a multi-tier leap feels bigger).
//
// Pure + deterministic — no IO, no randomness — so it is unit-testable and
// yields identical output on first-pass and any replay.

import type { TierNumber } from './TierBadge.types.js';

export type TierUpSeverity = 1 | 2 | 3 | 4;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Celebration severity for a tier-up crossing. Callers invoke this only on a
 * real up-crossing (toTier > fromTier); it is defensively clamped to [1, 4]
 * regardless so a degenerate input can never produce an out-of-range severity.
 */
export function tierUpSeverity(fromTier: TierNumber, toTier: TierNumber): TierUpSeverity {
  // Legendary (10) and Mythic (11) — always the full ritual.
  if (toTier >= 10) return 4;
  // Band floor by destination: Senator+ (7) -> 3; Operative+ (4) -> 2;
  // everything below -> 1.
  const base = toTier >= 7 ? 3 : toTier >= 4 ? 2 : 1;
  // Bigger single-settlement jump -> bigger celebration.
  const jump = toTier - fromTier; // >= 1 for a real up-crossing
  let severity = clamp(base + (jump - 1), 1, 4);
  // Payout-unlock milestone: reaching Operative (tier 3) is where real payouts
  // unlock (tiers.payout_eligible flips true), so it always celebrates at least
  // mid — bigger than a generic single step into a lower band.
  if (toTier === 3) severity = Math.max(severity, 2);
  return severity as TierUpSeverity;
}
