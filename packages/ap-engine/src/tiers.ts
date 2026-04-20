/**
 * Tier lookup helpers. Pure — no IO. All callers can rely on this resolving
 * an AP balance to the same tier the database row would have, because the
 * `TIER_BANDS` table mirrors the seed migration verbatim.
 */

import type { Tier } from '@diktat/shared';
import { TIER_BANDS, type TierBand } from './constants.js';

/**
 * Resolve a non-negative AP balance to its tier id (0..11).
 *
 * - Negative AP throws (the DB constraint forbids it; defending here too
 *   so engine-internal bugs surface loudly).
 * - AP at the band boundary lands in the higher band (e.g. 100 → Voter, 75 000 → Mythic).
 * - Anything `>= 75 000` is Mythic (open-ended top band).
 */
export function tierFromAp(ap: number): Tier {
  if (!Number.isFinite(ap)) {
    throw new RangeError(`tierFromAp: ap must be finite, got ${ap}`);
  }
  if (ap < 0) {
    throw new RangeError(`tierFromAp: ap must be >= 0, got ${ap}`);
  }
  // Walk from the top so the open-ended Mythic band wins for very large AP.
  for (let i = TIER_BANDS.length - 1; i >= 0; i--) {
    const band = TIER_BANDS[i];
    if (band !== undefined && ap >= band.apMin) {
      return band.id;
    }
  }
  // Unreachable — band 0 has apMin=0 — but TS needs a return.
  return 0;
}

/**
 * AP threshold for the next tier. Returns `null` when already at Mythic
 * (no higher tier to climb to).
 */
export function nextTierThreshold(ap: number): number | null {
  const current = tierFromAp(ap);
  if (current === 11) return null;
  const next = TIER_BANDS[current + 1];
  return next ? next.apMin : null;
}

/** Lookup the band metadata for a tier id. Throws on out-of-range input. */
export function tierMeta(tier: Tier): TierBand {
  const band = TIER_BANDS[tier];
  if (!band) {
    throw new RangeError(`tierMeta: unknown tier ${tier}`);
  }
  return band;
}
