// Heat composer weights. Export as a const so the operator can refit
// against the nightly digest in a follow-up PR without touching the
// composer code. Plan v3 starting values biased for under-50 / Gen Z
// audience heat:
//
//   - Reddit is DEFERRED (API approval outstanding). w_r slot kept
//     forward-compat; set to 0 so adding Reddit later is one weight
//     edit, not a code change.
//   - Google Trends is the highest-reliability signal (quantified
//     volume + deterministic news-URL match).
//   - X volume (when tweet_volume is present) outweighs presence-only.
//   - Bluesky is presence-only — small weight by design.
//
// 12h half-life matches docs/phase-5/trending-sources-2026-10-11.md.
// cross_source_bonus fires only when ≥2 distinct sources matched a
// cluster — rewards agreement across signal pools.

export interface HeatWeights {
  readonly w_g: number; // GDELT distinct-outlet count
  readonly w_r: number; // Reddit (DEFERRED — stays 0 until approval)
  readonly w_gt: number; // Google Trends
  readonly w_x: number; // X trends
  readonly w_bsk: number; // Bluesky
  readonly w_cross: number; // cross-source agreement bonus
  readonly half_life_hours: number;
  readonly cross_bonus_threshold: number; // # distinct sources
}

/** V1 shadow starting weights. Operator refits post-shadow. */
export const DEFAULT_HEAT_WEIGHTS: HeatWeights = {
  w_g: 0.8,
  w_r: 0.0,
  w_gt: 1.2,
  w_x: 1.0,
  w_bsk: 0.4,
  w_cross: 0.3,
  half_life_hours: 12,
  cross_bonus_threshold: 2,
};
