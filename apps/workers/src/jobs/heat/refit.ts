// Heat refit — offline tool that reads drop_shadow_log + the per-row
// heat_components jsonb and proposes a nudge to DEFAULT_HEAT_WEIGHTS
// against the operator's picks over the recent window.
//
// Intentionally no AI calls. The fit is a one-step z-score nudge:
//   - for each of the 5 source weights (w_g, w_gt, w_x, w_bsk, w_cross),
//     compute the mean of that component on picked candidates vs the
//     mean on the other top-5 candidates of the same night;
//   - z-score the delta against the within-day stddev of that component;
//   - nudge the weight by alpha * clip(z, -1, +1).
// alpha defaults to 0.1 so the step is small and composable with
// repeated refits as more nights accumulate. Weights are clamped to
// [MIN_WEIGHT, MAX_WEIGHT].
//
// Three export surfaces:
//   - computeAgreementStats(rows) — the "heat #1 == operator pick"
//     counter + rank distribution + skip-day heat ceiling. Used by
//     the Telegram digest line "Heat agreed with you X of last N
//     nights." and the refit report.
//   - proposeWeights(rows, current, alpha?) — the one-step nudge.
//   - formatReport(stats, proposed, current) — stdout text for the
//     `pnpm --filter=@diktat/workers heat:refit` entry.
//
// The refit tool NEVER writes weights. It prints a report + a diff.
// Applying a proposed weight set is a manual edit to weights.ts by
// the operator.

import { DEFAULT_HEAT_WEIGHTS, type HeatWeights } from './weights.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Component names the refit nudges. w_r is reserved forward-compat
 *  (Reddit, DEFERRED); the refit does not touch it until a Reddit
 *  component column lands on heat_components. half_life_hours and
 *  cross_bonus_threshold are shape parameters, not source weights —
 *  they are intentionally out of scope. */
export const REFITTABLE_WEIGHTS = ['w_g', 'w_gt', 'w_x', 'w_bsk', 'w_cross'] as const;
export type RefittableWeightKey = (typeof REFITTABLE_WEIGHTS)[number];

/** Per-component column name as it appears inside heat_components jsonb.
 *  Mirrors the composer: see supabase/migrations/20261101000000_heat_compose.sql
 *  and apps/workers/src/jobs/heat/compose.ts. */
export const COMPONENT_KEY_BY_WEIGHT: Record<RefittableWeightKey, string> = {
  w_g: 'gdelt_term',
  w_gt: 'google_term',
  w_x: 'x_term',
  w_bsk: 'bsky_term',
  w_cross: 'cross_bonus',
};

/** Minimum and maximum weight values after a nudge. Below 0 reverses
 *  the sign of a signal (dangerous — a negative weight treats high
 *  signal as a penalty), so we floor at 0. Above 2.5 crowds out
 *  every other signal, so we cap there. Both are soft limits a
 *  future PR can tune; for now they match the "small, explainable
 *  step" posture. */
const MIN_WEIGHT = 0;
const MAX_WEIGHT = 2.5;

/** Default alpha — the fraction of the clipped z-score that becomes
 *  the multiplicative nudge. 0.1 is small by design: one refit over
 *  14 nights at |z| = 1 shifts a weight by ±10%. */
const DEFAULT_ALPHA = 0.1;

/** A single row of drop_shadow_log, narrowed to what the refit needs.
 *  Reviewed-only — the caller filters `operator_picked_at IS NOT NULL`
 *  before passing rows in; this module does not re-check that. */
export interface ReviewedShadowRow {
  readonly drop_date: string;
  readonly operator_pick_candidate_id: string | null;
  readonly operator_picked_at: string;
  readonly shadow_top_5: ReadonlyArray<ShadowTopEntry>;
}

/** One entry inside drop_shadow_log.shadow_top_5. Only the fields the
 *  refit reads. */
export interface ShadowTopEntry {
  readonly candidate_id: string;
  readonly heat_score: number;
  readonly heat_components?: Record<string, unknown> | null;
}

/** Agreement counter + rank distribution + skip-day heat ceiling.
 *  Everything the digest line + the report need. */
export interface AgreementStats {
  /** Total reviewed nights (operator_picked_at IS NOT NULL). */
  readonly reviewed: number;
  /** Nights where operator chose a specific candidate. */
  readonly picks: number;
  /** Nights where operator explicitly skipped. */
  readonly skips: number;
  /** Nights where heat #1 == operator pick. Only counted on `picks`,
   *  never on skips (we don't define heat-agrees-with-skip here —
   *  there is no operator-recorded threshold to compare against). */
  readonly agreements: number;
  /** Count by operator-pick rank in the shadow_top_5 (1-based).
   *  `notInTop5` captures picks the heat composer did not rank at all. */
  readonly rankCounts: {
    readonly rank1: number;
    readonly rank2: number;
    readonly rank3: number;
    readonly rank4: number;
    readonly rank5: number;
    readonly notInTop5: number;
  };
  /** Mean heat_score of the top-1 candidate on skip-nights. A high
   *  number here suggests the operator skipped despite a "hot"
   *  candidate (worth a prompt tweak); a low number is the honest
   *  "nothing cleared the bar" case. null when there were no skips. */
  readonly skipTopHeatMean: number | null;
}

/** Diff of a proposed weight set vs the current one. */
export interface ProposedWeightDiff {
  readonly key: RefittableWeightKey;
  /** The jsonb column name on heat_components that this weight scales. */
  readonly component: string;
  readonly current: number;
  readonly proposed: number;
  /** The within-day mean on picks minus the within-day mean on
   *  non-pick top-5 companions, averaged across nights. The sign of
   *  this tells the operator whether the nudge is up or down. */
  readonly meanDelta: number;
  /** The clipped z-score that drove the nudge. In [-1, +1]. */
  readonly z: number;
  /** Number of (night, candidate) pairs that contributed to the fit
   *  for this weight. A low value → low confidence; the report
   *  surfaces this so the operator can read the proposal honestly. */
  readonly sampleSize: number;
}

/** The full refit output. */
export interface ProposedWeights {
  readonly current: HeatWeights;
  readonly proposed: HeatWeights;
  readonly diffs: ReadonlyArray<ProposedWeightDiff>;
  readonly alpha: number;
}

// ---------------------------------------------------------------------------
// Agreement stats
// ---------------------------------------------------------------------------

/** Pure function: compute agreement + rank distribution + skip-day
 *  heat ceiling over the reviewed shadow rows passed in. */
export function computeAgreementStats(rows: ReadonlyArray<ReviewedShadowRow>): AgreementStats {
  let picks = 0;
  let skips = 0;
  let agreements = 0;
  const rank: {
    rank1: number;
    rank2: number;
    rank3: number;
    rank4: number;
    rank5: number;
    notInTop5: number;
  } = {
    rank1: 0,
    rank2: 0,
    rank3: 0,
    rank4: 0,
    rank5: 0,
    notInTop5: 0,
  };
  const skipTopHeats: number[] = [];

  for (const r of rows) {
    if (r.operator_pick_candidate_id === null) {
      skips += 1;
      if (r.shadow_top_5.length > 0) {
        skipTopHeats.push(r.shadow_top_5[0]!.heat_score);
      }
      continue;
    }
    picks += 1;
    const idx = r.shadow_top_5.findIndex((e) => e.candidate_id === r.operator_pick_candidate_id);
    if (idx === 0) {
      agreements += 1;
      rank.rank1 += 1;
    } else if (idx === 1) {
      rank.rank2 += 1;
    } else if (idx === 2) {
      rank.rank3 += 1;
    } else if (idx === 3) {
      rank.rank4 += 1;
    } else if (idx === 4) {
      rank.rank5 += 1;
    } else {
      rank.notInTop5 += 1;
    }
  }

  const skipTopHeatMean =
    skipTopHeats.length === 0
      ? null
      : skipTopHeats.reduce((a, b) => a + b, 0) / skipTopHeats.length;

  return {
    reviewed: picks + skips,
    picks,
    skips,
    agreements,
    rankCounts: rank,
    skipTopHeatMean,
  };
}

// ---------------------------------------------------------------------------
// Refit
// ---------------------------------------------------------------------------

/** Pull a numeric heat component value out of the jsonb bag, or null
 *  if absent / non-numeric. Non-finite values (NaN, ±Infinity) are
 *  treated as null — the composer never writes them, but defence-in-
 *  depth. */
function componentValue(
  components: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!components) return null;
  const v = components[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/** Simple variance (not sample / Bessel-corrected). Returns 0 when
 *  the array has fewer than 2 points. */
function variance(values: ReadonlyArray<number>): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return sq / values.length;
}

function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Z-score nudge for a single weight.
 *
 *  For each night in the reviewed+picked subset, collect
 *    pick_value  = heat_components[component] on the operator's pick,
 *    nonpick_values = heat_components[component] on the other top-5
 *                     entries of the SAME night.
 *  Within-night sign is the mean of (pick - nonpick_mean). We average
 *  that per-night signed delta across nights to get `meanDelta`.
 *
 *  z = meanDelta / within-day stddev, clipped to [-1, +1]. A positive
 *  z means picks had HIGHER component values than the composer's
 *  other candidates — bump the weight up. Negative → bump down.
 *
 *  Nudge: proposed = current * (1 + alpha * z), clamped to the
 *  [MIN_WEIGHT, MAX_WEIGHT] band. */
function nudgeOne(
  rows: ReadonlyArray<ReviewedShadowRow>,
  key: RefittableWeightKey,
  current: number,
  alpha: number,
): { proposed: number; meanDelta: number; z: number; sampleSize: number } {
  const component = COMPONENT_KEY_BY_WEIGHT[key];
  const perNightDeltas: number[] = [];
  const allValues: number[] = [];
  let sampleSize = 0;

  for (const r of rows) {
    if (r.operator_pick_candidate_id === null) continue;
    const pickEntry = r.shadow_top_5.find((e) => e.candidate_id === r.operator_pick_candidate_id);
    if (!pickEntry) continue;
    const pickValue = componentValue(pickEntry.heat_components ?? null, component);
    if (pickValue === null) continue;

    const nonPickValues: number[] = [];
    for (const e of r.shadow_top_5) {
      if (e.candidate_id === r.operator_pick_candidate_id) continue;
      const v = componentValue(e.heat_components ?? null, component);
      if (v !== null) {
        nonPickValues.push(v);
        allValues.push(v);
      }
    }
    if (nonPickValues.length === 0) continue;
    const nonPickMean = nonPickValues.reduce((a, b) => a + b, 0) / nonPickValues.length;
    perNightDeltas.push(pickValue - nonPickMean);
    allValues.push(pickValue);
    sampleSize += 1 + nonPickValues.length;
  }

  if (perNightDeltas.length === 0) {
    return { proposed: current, meanDelta: 0, z: 0, sampleSize: 0 };
  }
  const meanDelta = perNightDeltas.reduce((a, b) => a + b, 0) / perNightDeltas.length;
  // Use the stddev of the full picks+nonpicks pool as the z denominator.
  // When the pool is degenerate (every candidate has the same component
  // value — common with the small per-night fixtures), fall back to
  // `|meanDelta|` so the sign of the nudge still reflects the direction
  // of the operator's preference. Without this fallback a reviewer
  // can't correct a weight the operator consistently biases toward a
  // single component value.
  const sd = Math.sqrt(variance(allValues));
  const denom = sd > 0 ? sd : Math.abs(meanDelta);
  const z = denom === 0 ? 0 : clip(meanDelta / denom, -1, 1);
  const proposed = clip(current * (1 + alpha * z), MIN_WEIGHT, MAX_WEIGHT);
  return { proposed, meanDelta, z, sampleSize };
}

/** Propose a one-step nudge to the five source weights. Does NOT
 *  touch w_r (DEFERRED), half_life_hours, or cross_bonus_threshold. */
export function proposeWeights(
  rows: ReadonlyArray<ReviewedShadowRow>,
  current: HeatWeights = DEFAULT_HEAT_WEIGHTS,
  alpha: number = DEFAULT_ALPHA,
): ProposedWeights {
  const diffs: ProposedWeightDiff[] = [];
  const proposedBag: Record<RefittableWeightKey, number> = {
    w_g: current.w_g,
    w_gt: current.w_gt,
    w_x: current.w_x,
    w_bsk: current.w_bsk,
    w_cross: current.w_cross,
  };
  for (const key of REFITTABLE_WEIGHTS) {
    const { proposed, meanDelta, z, sampleSize } = nudgeOne(rows, key, current[key], alpha);
    proposedBag[key] = proposed;
    diffs.push({
      key,
      component: COMPONENT_KEY_BY_WEIGHT[key],
      current: current[key],
      proposed,
      meanDelta,
      z,
      sampleSize,
    });
  }
  const proposed: HeatWeights = {
    ...current,
    ...proposedBag,
  };
  return { current, proposed, diffs, alpha };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function percent(x: number, n: number): string {
  if (n === 0) return 'n/a';
  return `${((x / n) * 100).toFixed(1)}%`;
}

/** Human-readable report. Three sections: agreement stats, skip-day
 *  heat ceiling, and the weights diff. The last line of each diff
 *  entry says "no change" when the proposed value equals the
 *  current one (sample too small or z == 0). */
export function formatReport(
  stats: AgreementStats,
  proposed: ProposedWeights,
  windowLabel: string,
): string {
  const lines: string[] = [];
  lines.push('# heat refit report');
  lines.push('');
  lines.push(`window: ${windowLabel}`);
  lines.push('');

  lines.push('## agreement stats');
  lines.push(`  reviewed nights:    ${stats.reviewed}`);
  lines.push(`  operator picked:    ${stats.picks}`);
  lines.push(`  operator skipped:   ${stats.skips}`);
  lines.push(
    `  heat #1 == pick:    ${stats.agreements}  (${percent(stats.agreements, stats.picks)} of picks)`,
  );
  lines.push('');
  lines.push("  operator pick's rank in shadow_top_5:");
  const rc = stats.rankCounts;
  lines.push(`    rank 1:         ${rc.rank1}`);
  lines.push(`    rank 2:         ${rc.rank2}`);
  lines.push(`    rank 3:         ${rc.rank3}`);
  lines.push(`    rank 4:         ${rc.rank4}`);
  lines.push(`    rank 5:         ${rc.rank5}`);
  lines.push(`    not in top 5:   ${rc.notInTop5}`);
  lines.push('');

  lines.push('## skip-day heat ceiling');
  if (stats.skips === 0) {
    lines.push('  (no skip-days in window)');
  } else {
    lines.push(`  mean top-1 heat_score on skip-days: ${fmt(stats.skipTopHeatMean ?? 0)}`);
    lines.push(
      "  (high → operator skipped despite a hot candidate; low → honest 'nothing cleared the bar')",
    );
  }
  lines.push('');

  lines.push(`## proposed weights diff (alpha=${proposed.alpha})`);
  lines.push('  key       component      current  →  proposed    z     meanΔ    n');
  for (const d of proposed.diffs) {
    const changed = d.proposed !== d.current ? '*' : ' ';
    lines.push(
      `  ${d.key.padEnd(8)} ${d.component.padEnd(13)} ${fmt(d.current).padStart(7)}  →  ${fmt(
        d.proposed,
      ).padStart(
        7,
      )}  ${fmt(d.z, 2).padStart(5)}  ${fmt(d.meanDelta).padStart(7)}  ${String(d.sampleSize).padStart(3)} ${changed}`,
    );
  }
  lines.push('  (* = proposed differs from current)');
  lines.push('');
  lines.push('# never writes. apply by editing apps/workers/src/jobs/heat/weights.ts');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Digest line
// ---------------------------------------------------------------------------

/** The one-line summary the nightly Telegram digest appends:
 *  "Heat agreed with you X of last N nights."
 *  N is the pick-only count (we don't define agreement on skip
 *  nights, see AgreementStats docs above). On zero picks we emit a
 *  flat message to avoid a divide-by-zero look. */
export function formatAgreementLine(stats: AgreementStats): string {
  if (stats.picks === 0) {
    return 'Heat agreed with you on 0 of last 0 nights (no picks yet).';
  }
  return `Heat agreed with you ${stats.agreements} of last ${stats.picks} nights.`;
}
