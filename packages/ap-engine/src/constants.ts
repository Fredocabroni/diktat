/**
 * Canonical AP-engine constants.
 *
 * The 12-tier band table mirrors `supabase/migrations/20260420090003_seed_tiers.sql`
 * exactly. If the seed migration changes, update this file in lockstep — the seed
 * is the source of truth and a divergence will cause the engine to disagree with
 * the database (and break floor protections).
 */

import type { Tier } from '@diktat/shared';

/**
 * Per-tier metadata. `apMax === null` means open-ended (Mythic).
 *
 * Bands are inclusive on both ends. Mythic starts at 75 000 AP and has no ceiling.
 */
export interface TierBand {
  readonly id: Tier;
  readonly name: string;
  readonly apMin: number;
  readonly apMax: number | null;
  readonly payoutEligible: boolean;
  /**
   * When true, the tier's `apMin` acts as a hard floor: a loss inside this tier
   * cannot drop a user's AP below `apMin`. Tiers 0–6 are floor-protected;
   * tiers 7+ are competitive ladders with no floor (matches seed migration).
   */
  readonly floorProtected: boolean;
}

export const TIER_BANDS: readonly TierBand[] = [
  { id: 0, name: 'Citizen', apMin: 0, apMax: 99, payoutEligible: false, floorProtected: true },
  { id: 1, name: 'Voter', apMin: 100, apMax: 299, payoutEligible: false, floorProtected: true },
  { id: 2, name: 'Partisan', apMin: 300, apMax: 749, payoutEligible: false, floorProtected: true },
  { id: 3, name: 'Operative', apMin: 750, apMax: 1499, payoutEligible: true, floorProtected: true },
  {
    id: 4,
    name: 'Strategist',
    apMin: 1500,
    apMax: 2999,
    payoutEligible: true,
    floorProtected: true,
  },
  {
    id: 5,
    name: 'Tactician',
    apMin: 3000,
    apMax: 5499,
    payoutEligible: true,
    floorProtected: true,
  },
  { id: 6, name: 'Vanguard', apMin: 5500, apMax: 9999, payoutEligible: true, floorProtected: true },
  {
    id: 7,
    name: 'Senator',
    apMin: 10000,
    apMax: 17999,
    payoutEligible: true,
    floorProtected: false,
  },
  {
    id: 8,
    name: 'Statesman',
    apMin: 18000,
    apMax: 29999,
    payoutEligible: true,
    floorProtected: false,
  },
  {
    id: 9,
    name: 'Architect',
    apMin: 30000,
    apMax: 46999,
    payoutEligible: true,
    floorProtected: false,
  },
  {
    id: 10,
    name: 'Legendary',
    apMin: 47000,
    apMax: 74999,
    payoutEligible: true,
    floorProtected: false,
  },
  {
    id: 11,
    name: 'Mythic',
    apMin: 75000,
    apMax: null,
    payoutEligible: true,
    floorProtected: false,
  },
] as const;

/**
 * K-factor lookup by tier id. Lower tiers swing harder to accelerate the
 * climb out of the on-ramp; high tiers are more stable.
 *
 * Bands per the master plan: t0–t2 = 64, t3–t5 = 48, t6–t8 = 32, t9–t11 = 24.
 */
export const K_FACTORS_BY_TIER: { readonly [T in Tier]: number } = {
  0: 64,
  1: 64,
  2: 64,
  3: 48,
  4: 48,
  5: 48,
  6: 32,
  7: 32,
  8: 32,
  9: 24,
  10: 24,
  11: 24,
} as const;

/** Hard cap on the absolute value of any single AP delta (per side). */
export const MAX_DELTA_CAP = 120 as const;

/**
 * Minimum non-zero AP movement. ELO can produce sub-1 results for a near-tie;
 * we round + apply this floor so wins always feel like wins (and losses bite).
 *
 * Applied symmetrically: winner gets at least +5, loser at most -5
 * (before tier-floor + loss-streak protections may further attenuate the loser).
 */
export const MIN_DELTA_FLOOR = 5 as const;

/**
 * Loss-streak protection threshold. After this many consecutive losses, the
 * NEXT loss starts being reduced (i.e. losses 1, 2, 3 are full; loss 4
 * is the first reduced one).
 */
export const LOSS_STREAK_THRESHOLD = 3 as const;

/** Reduction factor applied to the raw loss while protection is active (30%). */
export const LOSS_STREAK_REDUCTION = 0.3 as const;

/** Maximum number of reductions before protection exhausts. */
export const MAX_REDUCTIONS = 2 as const;

/**
 * First tier index that is NOT floor-protected. Tiers `[0, TIER_FLOOR_LIMIT)`
 * are floor-protected, tiers `[TIER_FLOOR_LIMIT, 11]` are not.
 */
export const TIER_FLOOR_LIMIT = 7 as const;

/**
 * USDC micros minted per AP for ghost-economy winners.
 *
 * 1 000 micros = $0.001 — small enough to preserve the integrity of real
 * payouts at higher tiers, large enough to make the ghost economy visible
 * to brand-new users (a 50-AP win mints $0.05 worth of "wallet experience").
 *
 * Only credited at tiers 0–2 (the non-payout tiers), where the dollar value
 * exists purely to teach the wallet UX without obligating payout infrastructure.
 */
export const GHOST_USD_MICROS_PER_AP = 1000n as const;
