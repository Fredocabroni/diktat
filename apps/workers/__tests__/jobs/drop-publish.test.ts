import { describe, expect, it } from 'vitest';

import { __testing, dropPublishHandler } from '../../src/jobs/drop-publish.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const { selectDropFromPool, decideCurationMode, todayDropAtEt, DOMINANCE_RATIO } = __testing;

// ---------------------------------------------------------------------------
// Pure selection logic
// ---------------------------------------------------------------------------

interface MinimalCandidate {
  id: string;
  source_provider: string;
  source_category: string;
  source_title: string;
  source_url: string;
  source_host: string;
  source_published_at: string | null;
  summary: string | null;
  dedup_cluster_id: string;
  rank_score: number;
}

function cand(overrides: Partial<MinimalCandidate>): MinimalCandidate {
  return {
    id: overrides.id ?? 'c-1',
    source_provider: 'congress',
    source_category: 'congress',
    source_title: 'Senate passes HR-1234 52-48',
    source_url: 'https://www.congress.gov/bill/118hr1234',
    source_host: 'congress.gov',
    source_published_at: null,
    summary: null,
    dedup_cluster_id: 'cluster-A',
    rank_score: 3.0,
    ...overrides,
  };
}

describe('selectDropFromPool — blocked-cluster mechanic', () => {
  it('returns null on an empty pool', () => {
    expect(selectDropFromPool({ candidates: [], blockedClusters: new Set() })).toBeNull();
  });

  it('picks the top candidate when no clusters are blocked', () => {
    const pool = [
      cand({ id: 'a', dedup_cluster_id: 'A', rank_score: 5.0 }),
      cand({ id: 'b', dedup_cluster_id: 'B', rank_score: 3.0 }),
    ];
    const result = selectDropFromPool({ candidates: pool, blockedClusters: new Set() });
    expect(result?.chosen.id).toBe('a');
    expect(result?.runnerUp?.id).toBe('b');
    expect(result?.blockExhausted).toBe(false);
  });

  it('skips a blocked top candidate, picks next unblocked (no score-dominance override)', () => {
    // Cluster A is dominant (score 100) but blocked from 3-day repeat.
    // Cluster B at score 1.0 wins because A is excluded.
    const pool = [
      cand({ id: 'a1', dedup_cluster_id: 'A', rank_score: 100.0 }),
      cand({ id: 'b1', dedup_cluster_id: 'B', rank_score: 1.0 }),
    ];
    const result = selectDropFromPool({
      candidates: pool,
      blockedClusters: new Set(['A']),
    });
    expect(result?.chosen.id).toBe('b1');
    expect(result?.blockExhausted).toBe(false);
  });

  it('runner-up is the top candidate in a DIFFERENT cluster (not just next in rank)', () => {
    // Two candidates share cluster A (top two by raw score). The
    // runner-up should be the cluster B candidate, not the second
    // A-candidate — same cluster = same story = invalid comparison.
    const pool = [
      cand({ id: 'a1', dedup_cluster_id: 'A', rank_score: 5.0 }),
      cand({ id: 'a2', dedup_cluster_id: 'A', rank_score: 4.5 }),
      cand({ id: 'b1', dedup_cluster_id: 'B', rank_score: 2.0 }),
    ];
    const result = selectDropFromPool({ candidates: pool, blockedClusters: new Set() });
    expect(result?.chosen.id).toBe('a1');
    expect(result?.runnerUp?.id).toBe('b1');
  });

  it('block-exhausted: every cluster blocked → publish absolute top, flag block_exhausted', () => {
    // §5 contract: never skip a day. When all candidates fall in
    // blocked clusters, we still publish the strongest one and stamp
    // block_exhausted=true for ops visibility.
    const pool = [
      cand({ id: 'a1', dedup_cluster_id: 'A', rank_score: 5.0 }),
      cand({ id: 'b1', dedup_cluster_id: 'B', rank_score: 3.0 }),
    ];
    const result = selectDropFromPool({
      candidates: pool,
      blockedClusters: new Set(['A', 'B']),
    });
    expect(result?.chosen.id).toBe('a1');
    expect(result?.blockExhausted).toBe(true);
  });

  it('single-cluster pool: no runner-up (null)', () => {
    const pool = [
      cand({ id: 'a1', dedup_cluster_id: 'A', rank_score: 5.0 }),
      cand({ id: 'a2', dedup_cluster_id: 'A', rank_score: 3.0 }),
    ];
    const result = selectDropFromPool({ candidates: pool, blockedClusters: new Set() });
    expect(result?.chosen.id).toBe('a1');
    expect(result?.runnerUp).toBeNull();
  });

  it('defensively re-sorts the input by rank_score desc', () => {
    // Caller passes unordered; the selector must not trust order.
    const pool = [
      cand({ id: 'low', dedup_cluster_id: 'A', rank_score: 1.0 }),
      cand({ id: 'high', dedup_cluster_id: 'B', rank_score: 5.0 }),
    ];
    const result = selectDropFromPool({ candidates: pool, blockedClusters: new Set() });
    expect(result?.chosen.id).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Confidence threshold (the auto_dominant gate)
// ---------------------------------------------------------------------------

describe('decideCurationMode — confidence threshold', () => {
  it('auto_dominant when chosen > 2× runner-up (strict inequality)', () => {
    expect(decideCurationMode({ chosenScore: 3.01, runnerUpScore: 1.5 })).toBe('auto_dominant');
  });

  it('auto_fallback_no_channel when chosen = 2× runner-up (boundary not dominant)', () => {
    expect(decideCurationMode({ chosenScore: 3.0, runnerUpScore: 1.5 })).toBe(
      'auto_fallback_no_channel',
    );
  });

  it('auto_fallback_no_channel when tight spread', () => {
    expect(decideCurationMode({ chosenScore: 2.0, runnerUpScore: 1.9 })).toBe(
      'auto_fallback_no_channel',
    );
  });

  it('auto_dominant when no runner-up exists', () => {
    // Single-cluster pool — nothing to compare against; treat as dominant.
    expect(decideCurationMode({ chosenScore: 5.0, runnerUpScore: null })).toBe('auto_dominant');
  });

  it('auto_dominant when runner-up score is zero (division-by-zero guard)', () => {
    expect(decideCurationMode({ chosenScore: 5.0, runnerUpScore: 0 })).toBe('auto_dominant');
  });

  it('DOMINANCE_RATIO is exactly 2.0 (founder-call lock)', () => {
    expect(DOMINANCE_RATIO).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// todayDropAtEt — 20:00 ET anchor
// ---------------------------------------------------------------------------

describe('todayDropAtEt — 20:00 ET anchor (§5 never-move-the-time)', () => {
  it('summer (EDT, UTC-4): 20:00 ET = 00:00Z next day', () => {
    // 2026-06-16 noon UTC = 2026-06-16 08:00 EDT. Today's drop = 20:00 EDT = 2026-06-17 00:00Z.
    const summerNoonUtc = new Date('2026-06-16T12:00:00Z');
    expect(todayDropAtEt(summerNoonUtc)).toBe('2026-06-17T00:00:00.000Z');
  });

  it('winter (EST, UTC-5): 20:00 ET = 01:00Z next day', () => {
    // 2026-01-15 noon UTC = 2026-01-15 07:00 EST. Today's drop = 20:00 EST = 2026-01-16 01:00Z.
    const winterNoonUtc = new Date('2026-01-15T12:00:00Z');
    expect(todayDropAtEt(winterNoonUtc)).toBe('2026-01-16T01:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Handler — DB integration via a fake supabase
// ---------------------------------------------------------------------------

interface RecentDrop {
  dedup_cluster_id: string | null;
  is_drop: boolean;
  drop_at: string;
}

interface FakeState {
  candidates: MinimalCandidate[];
  recentDrops: RecentDrop[];
  newsTopicInserts: Record<string, unknown>[];
  candidateUpdates: { filter: Record<string, unknown>; patch: Record<string, unknown> }[];
  payloadUpdates: { id: string; patch: Record<string, unknown> }[];
  insertError: { message: string } | null;
  nextNewsTopicId: string;
}

function buildSupabase(state: FakeState): ServiceClient {
  const fromImpl = (table: string) => ({
    select(_cols: string) {
      const handler = {
        _isNull: [] as string[],
        _isNotNull: [] as string[],
        _eq: [] as { col: string; val: unknown }[],
        _gte: [] as { col: string; val: unknown }[],
        eq(col: string, val: unknown) {
          this._eq.push({ col, val });
          return this;
        },
        is(col: string, val: unknown) {
          if (val === null) this._isNull.push(col);
          return this;
        },
        not(col: string, _op: string, val: unknown) {
          if (val === null) this._isNotNull.push(col);
          return this;
        },
        gte(col: string, val: unknown) {
          this._gte.push({ col, val });
          return this;
        },
        order() {
          return this;
        },
        single() {
          const data = this._collect();
          return Promise.resolve({ data: data[0] ?? null, error: null });
        },
        maybeSingle() {
          const data = this._collect();
          return Promise.resolve({ data: data[0] ?? null, error: null });
        },
        then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: this._collect(), error: null }).then(resolve);
        },
        _collect(): Record<string, unknown>[] {
          let rows: Record<string, unknown>[];
          if (table === 'news_topics_candidates') {
            rows = state.candidates as unknown as Record<string, unknown>[];
          } else if (table === 'news_topics') {
            rows = state.recentDrops as unknown as Record<string, unknown>[];
          } else {
            rows = [];
          }
          return rows.filter((r) => {
            for (const f of this._eq) {
              if (r[f.col] !== f.val) return false;
            }
            for (const c of this._isNull) {
              if (r[c] != null) return false;
            }
            for (const c of this._isNotNull) {
              if (r[c] == null) return false;
            }
            for (const f of this._gte) {
              if (r[f.col] !== undefined && String(r[f.col]) < String(f.val)) return false;
            }
            return true;
          });
        },
      };
      return handler;
    },
    insert(row: Record<string, unknown>) {
      if (table === 'news_topics') {
        if (state.insertError) {
          return {
            select: () => ({
              single: () => Promise.resolve({ data: null, error: state.insertError }),
            }),
          };
        }
        state.newsTopicInserts.push(row);
        const id = state.nextNewsTopicId;
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id }, error: null }),
          }),
        };
      }
      return {
        select: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      };
    },
    update(patch: Record<string, unknown>) {
      const filter: Record<string, unknown> = {};
      const upd = {
        eq(col: string, val: unknown) {
          filter[col] = val;
          if (table === 'news_topics_candidates') {
            state.candidateUpdates.push({ filter: { ...filter }, patch });
          } else if (table === 'scheduled_jobs') {
            state.payloadUpdates.push({ id: String(val), patch });
          }
          return this;
        },
        is(col: string, val: unknown) {
          filter[col] = val;
          return Promise.resolve({ error: null });
        },
      };
      return upd;
    },
  });
  return { from: fromImpl } as unknown as ServiceClient;
}

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

function row(): ScheduledJobRow {
  return {
    id: 'job-1',
    job_type: 'drop_publish',
    idempotency_key: '2026-06-16',
    target_user_id: null,
    payload: { emitted_at_et: '2026-06-16 20:00:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'workers-test',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('dropPublishHandler', () => {
  it('empty pool: logs no_candidates, makes no inserts', async () => {
    const state: FakeState = {
      candidates: [],
      recentDrops: [],
      newsTopicInserts: [],
      candidateUpdates: [],
      payloadUpdates: [],
      insertError: null,
      nextNewsTopicId: 'nt-1',
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await dropPublishHandler(row(), { supabase, logger });
    expect(state.newsTopicInserts).toHaveLength(0);
    expect(logger.calls.find((c) => c.obj.event === 'drop_publish.no_candidates')).toBeDefined();
  });

  it('happy path: picks top, inserts news_topics with verbatim source_title, stamps outcome', async () => {
    const state: FakeState = {
      candidates: [
        cand({ id: 'a', dedup_cluster_id: 'A', rank_score: 5.0 }),
        cand({
          id: 'b',
          dedup_cluster_id: 'B',
          rank_score: 1.0,
          source_title: 'CDC reports low flu',
        }),
      ],
      recentDrops: [],
      newsTopicInserts: [],
      candidateUpdates: [],
      payloadUpdates: [],
      insertError: null,
      nextNewsTopicId: 'nt-1',
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await dropPublishHandler(row(), { supabase, logger });

    expect(state.newsTopicInserts).toHaveLength(1);
    const insert = state.newsTopicInserts[0]!;
    expect(insert.is_drop).toBe(true);
    expect(insert.headline).toBe('Senate passes HR-1234 52-48'); // verbatim — LLM rewrite lands in next commit
    expect(insert.source_title).toBe('Senate passes HR-1234 52-48');
    expect(insert.dedup_cluster_id).toBe('A');
    expect(insert.curation_mode).toBe('auto_dominant'); // 5.0 > 2×1.0
    expect(insert.primary_source_url).toBe('https://www.congress.gov/bill/118hr1234');

    const outcomeLog = logger.calls.find((c) => c.obj.event === 'drop_publish.complete');
    expect(outcomeLog?.obj.chosen_cluster_id).toBe('A');
    expect(outcomeLog?.obj.curation_mode).toBe('auto_dominant');
    expect(outcomeLog?.obj.block_exhausted).toBe(false);
  });

  it('honors 3-day cluster block: skips top-ranked blocked cluster for lower-ranked unblocked', async () => {
    const state: FakeState = {
      candidates: [
        cand({ id: 'a', dedup_cluster_id: 'A', rank_score: 100.0 }),
        cand({ id: 'b', dedup_cluster_id: 'B', rank_score: 1.0, source_title: 'CDC report' }),
      ],
      // Cluster A was the Drop yesterday → blocked from today.
      recentDrops: [{ dedup_cluster_id: 'A', is_drop: true, drop_at: new Date().toISOString() }],
      newsTopicInserts: [],
      candidateUpdates: [],
      payloadUpdates: [],
      insertError: null,
      nextNewsTopicId: 'nt-1',
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await dropPublishHandler(row(), { supabase, logger });

    expect(state.newsTopicInserts).toHaveLength(1);
    expect(state.newsTopicInserts[0]!.dedup_cluster_id).toBe('B');
    expect(state.newsTopicInserts[0]!.headline).toBe('CDC report');
  });

  it('tight spread (chosen ≤ 2× runner-up): curation_mode=auto_fallback_no_channel', async () => {
    const state: FakeState = {
      candidates: [
        cand({ id: 'a', dedup_cluster_id: 'A', rank_score: 2.0 }),
        cand({ id: 'b', dedup_cluster_id: 'B', rank_score: 1.5, source_title: 'Bls jobs' }),
      ],
      recentDrops: [],
      newsTopicInserts: [],
      candidateUpdates: [],
      payloadUpdates: [],
      insertError: null,
      nextNewsTopicId: 'nt-1',
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await dropPublishHandler(row(), { supabase, logger });
    expect(state.newsTopicInserts[0]!.curation_mode).toBe('auto_fallback_no_channel');
  });

  it('block-exhausted: every cluster blocked → publishes top anyway with block_exhausted=true', async () => {
    const state: FakeState = {
      candidates: [
        cand({ id: 'a', dedup_cluster_id: 'A', rank_score: 5.0 }),
        cand({ id: 'b', dedup_cluster_id: 'B', rank_score: 3.0, source_title: 'Other story' }),
      ],
      recentDrops: [
        { dedup_cluster_id: 'A', is_drop: true, drop_at: new Date().toISOString() },
        { dedup_cluster_id: 'B', is_drop: true, drop_at: new Date().toISOString() },
      ],
      newsTopicInserts: [],
      candidateUpdates: [],
      payloadUpdates: [],
      insertError: null,
      nextNewsTopicId: 'nt-1',
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await dropPublishHandler(row(), { supabase, logger });

    expect(state.newsTopicInserts).toHaveLength(1);
    expect(state.newsTopicInserts[0]!.dedup_cluster_id).toBe('A');
    const outcomeLog = logger.calls.find((c) => c.obj.event === 'drop_publish.complete');
    expect(outcomeLog?.obj.block_exhausted).toBe(true);
  });

  it('marks every candidate in the chosen cluster as selected', async () => {
    const state: FakeState = {
      candidates: [cand({ id: 'a', dedup_cluster_id: 'A', rank_score: 5.0 })],
      recentDrops: [],
      newsTopicInserts: [],
      candidateUpdates: [],
      payloadUpdates: [],
      insertError: null,
      nextNewsTopicId: 'nt-1',
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await dropPublishHandler(row(), { supabase, logger });
    // candidateUpdates should record the cluster-A selected_at flip.
    const flip = state.candidateUpdates.find(
      (u) => u.filter.dedup_cluster_id === 'A' && u.patch.selected_at !== undefined,
    );
    expect(flip).toBeDefined();
  });
});
