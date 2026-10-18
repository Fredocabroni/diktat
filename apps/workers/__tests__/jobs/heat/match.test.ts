import { describe, expect, it, vi } from 'vitest';

import {
  buildHeatSignalMatchHandler,
  buildUrlIndex,
  canonicalizeUrl,
  countShared,
  matchSignal,
  signalCandidateUrls,
  signalPrimaryText,
  tokenize,
  type ClusterIndexRow,
} from '../../../src/jobs/heat/match.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../../src/supabase.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops stopwords + short tokens', () => {
    const t = tokenize("The President's bill passes Senate 52-48");
    expect(t.has('president')).toBe(true);
    expect(t.has('bill')).toBe(true);
    expect(t.has('passes')).toBe(true);
    expect(t.has('senate')).toBe(true);
    // 2-char tokens like "52"/"48" are below the min-length-3 cut.
    expect(t.has('52')).toBe(false);
    // stopwords dropped
    expect(t.has('the')).toBe(false);
    // apostrophe-s stripped: 's' alone is too short
    expect(t.has('s')).toBe(false);
  });
  it('empty input returns empty set', () => {
    expect(tokenize('').size).toBe(0);
    expect(tokenize('   ').size).toBe(0);
  });
});

describe('countShared', () => {
  it('counts intersection; short-set loop is correct', () => {
    expect(countShared(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(2);
    expect(countShared(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('canonicalizeUrl', () => {
  it('strips www., lowercases host, drops query + fragment', () => {
    expect(canonicalizeUrl('https://WWW.APNews.com/article?utm=x#frag')).toBe(
      'https://apnews.com/article',
    );
  });
  it('drops trailing slash on non-root path, keeps "/" for root', () => {
    expect(canonicalizeUrl('https://x.com/a/')).toBe('https://x.com/a');
    expect(canonicalizeUrl('https://x.com/')).toBe('https://x.com/');
  });
  it('rejects non-http(s) and malformed', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not-a-url')).toBeNull();
  });
});

describe('signalPrimaryText', () => {
  it('google_trends folds trend title + news_item titles', () => {
    expect(
      signalPrimaryText(
        'google_trends',
        {
          title: 'winter weather forecast',
          news_items: [{ title: 'Winter storm hits Northeast' }, { title: 'Snow blankets Boston' }],
        },
        'fb',
      ),
    ).toContain('Snow blankets Boston');
  });
  it('wikimedia replaces underscores', () => {
    expect(signalPrimaryText('wikimedia_pageviews', { article: 'GBU-43/B_MOAB' }, 'fb')).toBe(
      'GBU-43/B MOAB',
    );
  });
  it('fallback is source_id when payload is empty', () => {
    expect(signalPrimaryText('bluesky', {}, 'topic-fb')).toBe('topic-fb');
  });
});

describe('signalCandidateUrls', () => {
  it('google_trends emits news_item urls', () => {
    expect(
      signalCandidateUrls('google_trends', {
        news_items: [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      }),
    ).toEqual(['https://a.com', 'https://b.com']);
  });
  it('other sources return empty', () => {
    expect(signalCandidateUrls('bluesky', { topic: 'x' })).toEqual([]);
  });
});

describe('buildUrlIndex', () => {
  it('canonicalizes URLs; first-seen wins on collision', () => {
    const idx = buildUrlIndex([
      { url: 'https://www.apnews.com/first?utm=1', global_event_id: 'G1' },
      { url: 'https://apnews.com/first', global_event_id: 'G2' },
    ]);
    expect(idx.get('https://apnews.com/first')).toBe('G1');
  });
});

// ---------------------------------------------------------------------------
// matchSignal
// ---------------------------------------------------------------------------

const CLUSTER_A: ClusterIndexRow = {
  global_event_id: 'A',
  first_seen_at_ms: Date.parse('2026-10-16T18:00:00Z'),
  last_seen_at_ms: Date.parse('2026-10-16T20:00:00Z'),
  tokens: tokenize('Senate passes HR-1234 bill 52-48'),
};

const CLUSTER_B: ClusterIndexRow = {
  global_event_id: 'B',
  first_seen_at_ms: Date.parse('2026-10-16T15:00:00Z'),
  last_seen_at_ms: Date.parse('2026-10-16T17:00:00Z'),
  tokens: tokenize('Winter weather forecast Northeast snow'),
};

describe('matchSignal', () => {
  it('URL match beats token match', () => {
    const result = matchSignal(
      {
        source: 'google_trends',
        source_id: 'winter|2026-10-16T19',
        payload: {
          title: 'winter weather forecast',
          news_items: [{ url: 'https://apnews.com/weather-piece' }],
        },
        created_at_ms: Date.parse('2026-10-16T19:00:00Z'),
      },
      [CLUSTER_B],
      buildUrlIndex([{ url: 'https://apnews.com/weather-piece', global_event_id: 'B' }]),
    );
    expect(result?.global_event_id).toBe('B');
    expect(result?.match_quality.method).toBe('url');
    expect(result?.match_quality.score).toBe(1.0);
  });

  it('token-time match returns highest shared count', () => {
    const result = matchSignal(
      {
        source: 'x_trends',
        source_id: 'HR-1234',
        payload: { trend_name: 'HR-1234 Senate bill 52-48' },
        created_at_ms: Date.parse('2026-10-16T19:00:00Z'),
      },
      [CLUSTER_A, CLUSTER_B],
      new Map(),
    );
    expect(result?.global_event_id).toBe('A');
    expect(result?.match_quality.method).toBe('token_time');
    expect(result?.match_quality.shared_tokens).toBeGreaterThanOrEqual(2);
  });

  it('near-miss (only 1 shared token) does not match', () => {
    const result = matchSignal(
      {
        source: 'bluesky',
        source_id: 'topic',
        payload: { topic: 'senate recess' }, // "senate" shared; "recess" not in cluster A
        created_at_ms: Date.parse('2026-10-16T19:00:00Z'),
      },
      [CLUSTER_A],
      new Map(),
    );
    expect(result).toBeNull();
  });

  it('time-window miss (signal 24h after cluster.last_seen_at+6h) does not match', () => {
    const result = matchSignal(
      {
        source: 'x_trends',
        source_id: 'late',
        payload: { trend_name: 'HR-1234 bill passes Senate' },
        created_at_ms: Date.parse('2026-10-18T19:00:00Z'),
      },
      [CLUSTER_A],
      new Map(),
    );
    expect(result).toBeNull();
  });

  it('wikimedia article slug underscore-stripped and matched', () => {
    const result = matchSignal(
      {
        source: 'wikimedia_pageviews',
        source_id: 'en.wikipedia:HR_1234:2026-10-16',
        payload: { article: 'HR_1234_bill' },
        created_at_ms: Date.parse('2026-10-16T19:00:00Z'),
      },
      [CLUSTER_A],
      new Map(),
    );
    // "hr", "1234", "bill" tokens; the cluster has HR-1234 → "hr", "1234", "bill" too.
    expect(result?.global_event_id).toBe('A');
  });

  it('within-window boundary (signal exactly at cluster.first_seen_at - 2h) matches', () => {
    const result = matchSignal(
      {
        source: 'x_trends',
        source_id: 'edge',
        payload: { trend_name: 'HR-1234 bill passes Senate' },
        created_at_ms: Date.parse('2026-10-16T16:00:00Z'),
      },
      [CLUSTER_A],
      new Map(),
    );
    expect(result?.global_event_id).toBe('A');
    expect(result?.match_quality.cluster_window_delta_ms).toBe(2 * 3600 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Handler end-to-end on a Supabase fake
// ---------------------------------------------------------------------------

interface LoggerSpy extends Logger {
  readonly calls: ReadonlyArray<{ level: string; obj: Record<string, unknown> }>;
}
function buildLogger(): LoggerSpy {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => {
    calls.push({ level, obj });
  };
  return {
    info: push('info') as Logger['info'],
    warn: push('warn') as Logger['warn'],
    error: push('error') as Logger['error'],
    debug: push('debug') as Logger['debug'],
    calls,
  } as LoggerSpy;
}

interface FakeSignal {
  id: string;
  source: 'google_trends' | 'bluesky' | 'x_trends' | 'wikimedia_pageviews' | 'reddit';
  source_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  global_event_id: string | null;
  match_quality: unknown;
}
interface FakeCluster {
  global_event_id: string;
  first_seen_at: string;
  last_seen_at: string;
  primary_url: string | null;
  best_news_url: string | null;
  drop_published_at: string | null;
}
interface FakeOutlet {
  global_event_id: string;
  url: string;
}
interface FakeCandidate {
  global_event_id: string;
  source_title: string;
}
interface FakeUnmatched {
  source: string;
  source_id: string;
  payload: Record<string, unknown>;
  reason: string | null;
}

function buildSupabase(state: {
  signals: FakeSignal[];
  clusters: FakeCluster[];
  outlets: FakeOutlet[];
  candidates: FakeCandidate[];
}): {
  client: ServiceClient;
  stamped: Array<{ rowId: string; payload: Record<string, unknown> }>;
  unmatched: FakeUnmatched[];
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
} {
  const stamped: Array<{ rowId: string; payload: Record<string, unknown> }> = [];
  const unmatched: FakeUnmatched[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const fromImpl = (table: string) => {
    if (table === 'trend_signals') {
      return {
        select: () => ({
          is: (_col: string, _val: null) => ({
            gt: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: state.signals.filter((s) => s.global_event_id === null),
                    error: null,
                  }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_c1: string, id: string) => ({
            is: (_c2: string, _val: null) => {
              const sig = state.signals.find((s) => s.id === id);
              if (!sig || sig.global_event_id !== null) {
                return Promise.resolve({ error: null });
              }
              sig.global_event_id = patch.global_event_id as string;
              sig.match_quality = patch.match_quality;
              updates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          }),
        }),
      };
    }
    if (table === 'gdelt_event_cluster') {
      return {
        select: () => ({
          gt: () => ({
            is: () =>
              Promise.resolve({
                data: state.clusters.filter((c) => c.drop_published_at === null),
                error: null,
              }),
          }),
        }),
      };
    }
    if (table === 'gdelt_event_cluster_outlet') {
      return {
        select: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({
              data: state.outlets.filter((o) => ids.includes(o.global_event_id)),
              error: null,
            }),
        }),
      };
    }
    if (table === 'news_topics_candidates') {
      return {
        select: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({
              data: state.candidates.filter((c) => ids.includes(c.global_event_id)),
              error: null,
            }),
        }),
      };
    }
    if (table === 'trend_signals_unmatched') {
      return {
        upsert: (
          row: FakeUnmatched,
          _opts: { onConflict?: string; ignoreDuplicates?: boolean },
        ) => {
          const existing = unmatched.find(
            (u) => u.source === row.source && u.source_id === row.source_id,
          );
          if (!existing) unmatched.push(row);
          return Promise.resolve({ error: null });
        },
      };
    }
    if (table === 'scheduled_jobs') {
      return {
        update: (updateArg: Record<string, unknown>) => ({
          eq: (_col: string, rowId: string) => {
            const payload = (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
            stamped.push({ rowId, payload });
            return Promise.resolve({ error: null });
          },
        }),
      };
    }
    throw new Error(`fake: unexpected table ${table}`);
  };

  return {
    client: { from: fromImpl } as unknown as ServiceClient,
    stamped,
    unmatched,
    updates,
  };
}

function buildRow(id = 'row-1'): ScheduledJobRow {
  return {
    id,
    job_type: 'heat_signal_match',
    idempotency_key: '2026-10-16 19:00',
    target_user_id: null,
    payload: { emitted_at: '2026-10-16 19:00:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: '2026-10-16T19:00:00Z',
    locked_at: '2026-10-16T19:00:01Z',
    locked_by: 'worker-test',
    last_error: null,
    processed_at: null,
    created_at: '2026-10-16T19:00:00Z',
    updated_at: '2026-10-16T19:00:00Z',
  };
}

describe('heat_signal_match handler', () => {
  it('empty signals: stamps outcome=ok, scanned=0', async () => {
    const supa = buildSupabase({ signals: [], clusters: [], outlets: [], candidates: [] });
    const logger = buildLogger();
    const handler = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(supa.stamped).toHaveLength(1);
    expect(supa.stamped[0]!.payload.outcome).toBe('ok');
    expect(supa.stamped[0]!.payload.scanned).toBe(0);
  });

  it('URL match attaches cluster and preserves idempotency on re-run', async () => {
    const state = {
      signals: [
        {
          id: 'sig-url',
          source: 'google_trends' as const,
          source_id: 'winter|2026-10-16T19',
          payload: {
            title: 'winter weather forecast',
            news_items: [{ url: 'https://apnews.com/weather-piece' }],
          },
          created_at: '2026-10-16T19:00:00Z',
          global_event_id: null,
          match_quality: null,
        },
      ],
      clusters: [
        {
          global_event_id: 'G-URL',
          first_seen_at: '2026-10-16T18:00:00Z',
          last_seen_at: '2026-10-16T20:00:00Z',
          primary_url: null,
          best_news_url: null,
          drop_published_at: null,
        },
      ],
      outlets: [{ global_event_id: 'G-URL', url: 'https://apnews.com/weather-piece' }],
      candidates: [],
    };
    const supa = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(supa.updates).toHaveLength(1);
    expect(supa.updates[0]!.patch.global_event_id).toBe('G-URL');
    expect(supa.stamped[0]!.payload.matched).toBe(1);
    // Second tick: signal is now attached; nothing to do.
    const supa2 = buildSupabase(state);
    const handler2 = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:15:00Z') });
    await handler2(buildRow('row-2'), { supabase: supa2.client, logger });
    expect(supa2.updates).toHaveLength(0);
    expect(supa2.stamped[0]!.payload.scanned).toBe(0);
  });

  it('token match within window attaches cluster', async () => {
    const state = {
      signals: [
        {
          id: 'sig-tok',
          source: 'bluesky' as const,
          source_id: 'topic-hr-1234',
          payload: { topic: 'HR-1234 Senate bill passes 52-48' },
          created_at: '2026-10-16T19:00:00Z',
          global_event_id: null,
          match_quality: null,
        },
      ],
      clusters: [
        {
          global_event_id: 'G-TOK',
          first_seen_at: '2026-10-16T18:00:00Z',
          last_seen_at: '2026-10-16T20:00:00Z',
          primary_url: null,
          best_news_url: null,
          drop_published_at: null,
        },
      ],
      outlets: [],
      candidates: [{ global_event_id: 'G-TOK', source_title: 'Senate passes HR-1234 bill 52-48' }],
    };
    const supa = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(supa.updates[0]!.patch.global_event_id).toBe('G-TOK');
    const mq = supa.updates[0]!.patch.match_quality as { method: string };
    expect(mq.method).toBe('token_time');
  });

  it('old unattached signal (>1h) escalates to trend_signals_unmatched', async () => {
    const state = {
      signals: [
        {
          id: 'sig-old',
          source: 'bluesky' as const,
          source_id: 'orphan-topic',
          payload: { topic: 'absolutely nothing matching anything else' },
          created_at: '2026-10-16T17:00:00Z', // 2h older than now
          global_event_id: null,
          match_quality: null,
        },
      ],
      clusters: [
        {
          global_event_id: 'G-ANY',
          first_seen_at: '2026-10-16T18:00:00Z',
          last_seen_at: '2026-10-16T20:00:00Z',
          primary_url: null,
          best_news_url: null,
          drop_published_at: null,
        },
      ],
      outlets: [],
      candidates: [{ global_event_id: 'G-ANY', source_title: 'Senate passes HR-1234 bill 52-48' }],
    };
    const supa = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(supa.updates).toHaveLength(0);
    expect(supa.unmatched).toHaveLength(1);
    expect(supa.unmatched[0]!.reason).toBe('no_match_after_1h');
    expect(supa.stamped[0]!.payload.gave_up).toBe(1);
  });

  it('fresh unattached signal (<1h) does NOT escalate — waits for more ticks', async () => {
    const state = {
      signals: [
        {
          id: 'sig-fresh',
          source: 'bluesky' as const,
          source_id: 'maybe-later',
          payload: { topic: 'quite distinctive phrasing' },
          created_at: '2026-10-16T18:45:00Z', // 15 min ago
          global_event_id: null,
          match_quality: null,
        },
      ],
      clusters: [],
      outlets: [],
      candidates: [],
    };
    const supa = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(supa.updates).toHaveLength(0);
    expect(supa.unmatched).toHaveLength(0);
    expect(supa.stamped[0]!.payload.gave_up).toBe(0);
  });

  it('near-miss title (only 1 shared token) does not match, does not escalate if fresh', async () => {
    const state = {
      signals: [
        {
          id: 'sig-nm',
          source: 'x_trends' as const,
          source_id: 'bill-senate-only',
          payload: { trend_name: 'bill senate recess' },
          created_at: '2026-10-16T18:55:00Z',
          global_event_id: null,
          match_quality: null,
        },
      ],
      clusters: [
        {
          global_event_id: 'G-NEARMISS',
          first_seen_at: '2026-10-16T18:00:00Z',
          last_seen_at: '2026-10-16T20:00:00Z',
          primary_url: null,
          best_news_url: null,
          drop_published_at: null,
        },
      ],
      outlets: [],
      candidates: [
        { global_event_id: 'G-NEARMISS', source_title: 'Senate passes HR-1234 bill 52-48' },
      ],
    };
    const supa = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler(buildRow(), { supabase: supa.client, logger });
    // Shared tokens here are {bill, senate} = exactly 2 → will match.
    // To exercise the 1-shared-token near-miss path, replace trend_name:
    const state2 = {
      ...state,
      signals: [
        {
          ...state.signals[0]!,
          id: 'sig-nm-2',
          source_id: 'single-shared-token',
          payload: { trend_name: 'senate recess holiday' },
          global_event_id: null,
          match_quality: null,
        },
      ],
    };
    const supa2 = buildSupabase(state2);
    const handler2 = buildHeatSignalMatchHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    await handler2(buildRow('row-nm2'), { supabase: supa2.client, logger });
    expect(supa2.updates).toHaveLength(0);
    expect(supa2.unmatched).toHaveLength(0);
    expect(supa2.stamped[0]!.payload.matched).toBe(0);
    expect(supa2.stamped[0]!.payload.gave_up).toBe(0);
  });
});

// Avoid an unused-import warning for the exported-but-not-used-at-top-level sentinel.
void vi;
