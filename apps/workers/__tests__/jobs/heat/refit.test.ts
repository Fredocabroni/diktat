// Fixture-based tests for apps/workers/src/jobs/heat/refit.ts.
// The three pure exports (computeAgreementStats, proposeWeights,
// formatReport) are tested in isolation against hand-built shadow
// rows that exercise the branches the live tool walks:
//   - pick-only nights (agreement vs no-agreement, rank distribution)
//   - skip-only nights (skipTopHeatMean)
//   - mixed nights with pick-not-in-top-5
//   - component-weight nudges in both signs
//   - clamp to [0, 2.5]
//   - empty-input edge case

import { describe, expect, it } from 'vitest';

import {
  COMPONENT_KEY_BY_WEIGHT,
  computeAgreementStats,
  formatAgreementLine,
  formatReport,
  proposeWeights,
  REFITTABLE_WEIGHTS,
  type ReviewedShadowRow,
  type ShadowTopEntry,
} from '../../../src/jobs/heat/refit.js';
import { DEFAULT_HEAT_WEIGHTS, type HeatWeights } from '../../../src/jobs/heat/weights.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function cand(
  id: string,
  heat_score: number,
  components: Record<string, number> | null = null,
): ShadowTopEntry {
  return {
    candidate_id: id,
    heat_score,
    heat_components: components,
  };
}

function night(
  drop_date: string,
  operator_pick: string | null,
  top5: ShadowTopEntry[],
): ReviewedShadowRow {
  return {
    drop_date,
    operator_pick_candidate_id: operator_pick,
    operator_picked_at: `${drop_date}T06:00:00Z`,
    shadow_top_5: top5,
  };
}

// ---------------------------------------------------------------------------
// Agreement stats
// ---------------------------------------------------------------------------

describe('computeAgreementStats', () => {
  it('counts picks, skips, and agreements correctly on a mixed window', () => {
    const rows = [
      // Pick agrees with heat #1
      night('2026-01-01', 'c1', [cand('c1', 10), cand('c2', 9), cand('c3', 8)]),
      // Pick disagrees (picked rank-3)
      night('2026-01-02', 'c3', [cand('c1', 10), cand('c2', 9), cand('c3', 8)]),
      // Skip-day with top heat 5
      night('2026-01-03', null, [cand('c1', 5), cand('c2', 4)]),
      // Pick agrees again
      night('2026-01-04', 'c1', [cand('c1', 7), cand('c2', 6)]),
    ];

    const s = computeAgreementStats(rows);
    expect(s.reviewed).toBe(4);
    expect(s.picks).toBe(3);
    expect(s.skips).toBe(1);
    expect(s.agreements).toBe(2);
    expect(s.rankCounts.rank1).toBe(2);
    expect(s.rankCounts.rank3).toBe(1);
    expect(s.rankCounts.rank2).toBe(0);
    expect(s.rankCounts.notInTop5).toBe(0);
    expect(s.skipTopHeatMean).toBe(5);
  });

  it('classifies a pick that is NOT in the shadow_top_5 as notInTop5', () => {
    const rows = [night('2026-01-01', 'c99', [cand('c1', 10), cand('c2', 9), cand('c3', 8)])];
    const s = computeAgreementStats(rows);
    expect(s.picks).toBe(1);
    expect(s.agreements).toBe(0);
    expect(s.rankCounts.rank1).toBe(0);
    expect(s.rankCounts.notInTop5).toBe(1);
  });

  it('returns skipTopHeatMean=null when there were no skips', () => {
    const rows = [night('2026-01-01', 'c1', [cand('c1', 10)])];
    const s = computeAgreementStats(rows);
    expect(s.skipTopHeatMean).toBeNull();
  });

  it('returns zeros for an empty input', () => {
    const s = computeAgreementStats([]);
    expect(s.reviewed).toBe(0);
    expect(s.picks).toBe(0);
    expect(s.skips).toBe(0);
    expect(s.agreements).toBe(0);
    expect(s.skipTopHeatMean).toBeNull();
  });

  it('averages top-1 heat across multiple skip-nights', () => {
    const rows = [
      night('2026-01-01', null, [cand('c1', 2)]),
      night('2026-01-02', null, [cand('c1', 4)]),
      night('2026-01-03', null, [cand('c1', 6)]),
    ];
    const s = computeAgreementStats(rows);
    expect(s.skipTopHeatMean).toBe(4);
    expect(s.skips).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Digest line
// ---------------------------------------------------------------------------

describe('formatAgreementLine', () => {
  it('renders the one-line digest summary for a pick-heavy window', () => {
    const stats = computeAgreementStats([
      night('2026-01-01', 'c1', [cand('c1', 10)]),
      night('2026-01-02', 'c1', [cand('c1', 10)]),
      night('2026-01-03', 'c2', [cand('c1', 10), cand('c2', 9)]),
    ]);
    expect(formatAgreementLine(stats)).toBe('Heat agreed with you 2 of last 3 nights.');
  });

  it('renders the honest "no picks yet" fallback when there are zero picks', () => {
    expect(formatAgreementLine(computeAgreementStats([]))).toContain('0 of last 0 nights');
    expect(formatAgreementLine(computeAgreementStats([]))).toContain('no picks yet');
  });

  it('does NOT count skip-nights toward the denominator', () => {
    // 2 picks, 1 agreement, plus 5 skip-nights. Denominator stays at 2.
    const rows = [
      night('2026-01-01', 'c1', [cand('c1', 10), cand('c2', 9)]),
      night('2026-01-02', 'c2', [cand('c1', 10), cand('c2', 9)]),
      ...Array.from({ length: 5 }, (_, i) => night(`2026-02-0${i + 1}`, null, [cand('cs', 3)])),
    ];
    const stats = computeAgreementStats(rows);
    expect(formatAgreementLine(stats)).toBe('Heat agreed with you 1 of last 2 nights.');
  });
});

// ---------------------------------------------------------------------------
// Weights nudge
// ---------------------------------------------------------------------------

describe('proposeWeights', () => {
  it('leaves all weights unchanged when there is no pick signal (empty input)', () => {
    const p = proposeWeights([]);
    expect(p.proposed).toEqual(DEFAULT_HEAT_WEIGHTS);
    for (const d of p.diffs) {
      expect(d.proposed).toBe(d.current);
      expect(d.z).toBe(0);
      expect(d.sampleSize).toBe(0);
    }
  });

  it('nudges a weight UP when operator picks consistently have HIGHER component values', () => {
    // Every night: pick carries google_term=10 while the others
    // carry google_term=1. Picks are strictly higher → z should be
    // positive → w_gt increases.
    const rows = Array.from({ length: 10 }, (_, i) =>
      night(`2026-02-${String(i + 1).padStart(2, '0')}`, 'c1', [
        cand('c1', 10, { google_term: 10, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
        cand('c2', 9, { google_term: 1, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
        cand('c3', 8, { google_term: 1, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
      ]),
    );
    const p = proposeWeights(rows);
    const wgt = p.diffs.find((d) => d.key === 'w_gt')!;
    expect(wgt.z).toBeGreaterThan(0);
    expect(wgt.proposed).toBeGreaterThan(wgt.current);
    expect(wgt.meanDelta).toBeGreaterThan(0);
  });

  it('nudges a weight DOWN when operator picks consistently have LOWER component values', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      night(`2026-02-${String(i + 1).padStart(2, '0')}`, 'c1', [
        cand('c1', 10, { google_term: 0, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
        cand('c2', 9, { google_term: 5, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
        cand('c3', 8, { google_term: 5, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
      ]),
    );
    const p = proposeWeights(rows);
    const wgt = p.diffs.find((d) => d.key === 'w_gt')!;
    expect(wgt.z).toBeLessThan(0);
    expect(wgt.proposed).toBeLessThan(wgt.current);
    expect(wgt.meanDelta).toBeLessThan(0);
  });

  it('respects the alpha parameter (smaller alpha → smaller nudge)', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      night(`2026-02-${String(i + 1).padStart(2, '0')}`, 'c1', [
        cand('c1', 10, { google_term: 10, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
        cand('c2', 9, { google_term: 1, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
      ]),
    );
    const small = proposeWeights(rows, DEFAULT_HEAT_WEIGHTS, 0.01);
    const large = proposeWeights(rows, DEFAULT_HEAT_WEIGHTS, 0.5);
    const smallWgt = small.diffs.find((d) => d.key === 'w_gt')!;
    const largeWgt = large.diffs.find((d) => d.key === 'w_gt')!;
    expect(largeWgt.proposed - largeWgt.current).toBeGreaterThan(
      smallWgt.proposed - smallWgt.current,
    );
  });

  it('does NOT touch w_r, half_life_hours, or cross_bonus_threshold', () => {
    const rows = [
      night('2026-02-01', 'c1', [
        cand('c1', 10, {
          google_term: 10,
          gdelt_term: 10,
          x_term: 10,
          bsky_term: 10,
          cross_bonus: 10,
        }),
      ]),
    ];
    const p = proposeWeights(rows);
    expect(p.proposed.w_r).toBe(DEFAULT_HEAT_WEIGHTS.w_r);
    expect(p.proposed.half_life_hours).toBe(DEFAULT_HEAT_WEIGHTS.half_life_hours);
    expect(p.proposed.cross_bonus_threshold).toBe(DEFAULT_HEAT_WEIGHTS.cross_bonus_threshold);
    // And REFITTABLE_WEIGHTS only lists the five source weights.
    expect(new Set(REFITTABLE_WEIGHTS)).toEqual(
      new Set(['w_g', 'w_gt', 'w_x', 'w_bsk', 'w_cross']),
    );
  });

  it('clamps a proposed weight to [0, 2.5] under an aggressive alpha', () => {
    const current: HeatWeights = { ...DEFAULT_HEAT_WEIGHTS, w_gt: 2.0 };
    const rows = Array.from({ length: 20 }, (_, i) =>
      night(`2026-02-${String((i % 28) + 1).padStart(2, '0')}`, 'c1', [
        cand('c1', 10, {
          google_term: 100,
          gdelt_term: 0,
          x_term: 0,
          bsky_term: 0,
          cross_bonus: 0,
        }),
        cand('c2', 9, { google_term: 0, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
      ]),
    );
    // alpha=10 forces the raw nudge well past the ceiling; the clamp
    // must hold it at ≤ 2.5.
    const p = proposeWeights(rows, current, 10);
    const wgt = p.diffs.find((d) => d.key === 'w_gt')!;
    expect(wgt.proposed).toBeLessThanOrEqual(2.5);
    expect(wgt.proposed).toBeGreaterThanOrEqual(0);
  });

  it('skips candidates with missing / non-numeric heat_components without crashing', () => {
    const rows = [
      night('2026-02-01', 'c1', [cand('c1', 10, null), cand('c2', 9, { google_term: 1 })]),
      night('2026-02-02', 'c1', [
        cand('c1', 10, { google_term: Number.NaN as number }),
        cand('c2', 9, { google_term: 1 }),
      ]),
    ];
    const p = proposeWeights(rows);
    // Nothing valid → no nudge for w_gt.
    const wgt = p.diffs.find((d) => d.key === 'w_gt')!;
    expect(wgt.sampleSize).toBe(0);
    expect(wgt.proposed).toBe(wgt.current);
  });

  it('maps each refittable weight to its heat_components column name verbatim', () => {
    // Pin the mapping — a composer column rename needs to update
    // BOTH the composer AND this map. The pin catches a lonely-side
    // drift at the next test run.
    expect(COMPONENT_KEY_BY_WEIGHT.w_g).toBe('gdelt_term');
    expect(COMPONENT_KEY_BY_WEIGHT.w_gt).toBe('google_term');
    expect(COMPONENT_KEY_BY_WEIGHT.w_x).toBe('x_term');
    expect(COMPONENT_KEY_BY_WEIGHT.w_bsk).toBe('bsky_term');
    expect(COMPONENT_KEY_BY_WEIGHT.w_cross).toBe('cross_bonus');
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  it('renders agreement stats, skip ceiling, and the weights diff in a single string', () => {
    const rows = [
      night('2026-01-01', 'c1', [
        cand('c1', 10, { google_term: 10, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
        cand('c2', 9, { google_term: 1, gdelt_term: 0, x_term: 0, bsky_term: 0, cross_bonus: 0 }),
      ]),
      night('2026-01-02', null, [cand('cs', 3)]),
    ];
    const stats = computeAgreementStats(rows);
    const proposed = proposeWeights(rows);
    const report = formatReport(stats, proposed, 'last 2 nights');

    expect(report).toContain('# heat refit report');
    expect(report).toContain('window: last 2 nights');
    expect(report).toContain('## agreement stats');
    expect(report).toContain('reviewed nights:');
    expect(report).toContain('heat #1 == pick');
    expect(report).toContain('## skip-day heat ceiling');
    expect(report).toContain('## proposed weights diff');
    expect(report).toMatch(/w_gt\s+google_term/);
    expect(report).toContain('# never writes.');
  });

  it('shows the "no skip-days in window" message when there were no skips', () => {
    const rows = [night('2026-01-01', 'c1', [cand('c1', 10)])];
    const report = formatReport(computeAgreementStats(rows), proposeWeights(rows), 'last 1 night');
    expect(report).toContain('(no skip-days in window)');
  });
});
