import { describe, expect, it, vi } from 'vitest';

import {
  __testing,
  buildNewsIngestHandler,
  type CandidateInput,
  type NewsIngestAdapter,
} from '../../src/jobs/news-ingest.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const { canonicalizeUrl } = __testing;

// ---------------------------------------------------------------------------
// canonicalizeUrl — the cheap first-pass dedup key
// ---------------------------------------------------------------------------

describe('canonicalizeUrl', () => {
  it('lowercases the host and strips www.', () => {
    expect(canonicalizeUrl('https://WWW.Congress.GOV/bill/118HR1234')).toBe(
      'https://congress.gov/bill/118hr1234',
    );
  });

  it('strips a trailing slash on a non-root path', () => {
    expect(canonicalizeUrl('https://bls.gov/news.release/')).toBe('https://bls.gov/news.release');
  });

  it('keeps the root slash when path is just "/"', () => {
    expect(canonicalizeUrl('https://congress.gov/')).toBe('https://congress.gov/');
  });

  it('strips utm_*, fbclid, gclid tracking params', () => {
    expect(
      canonicalizeUrl(
        'https://congress.gov/bill/1?utm_source=email&utm_medium=email&fbclid=abc&id=42',
      ),
    ).toBe('https://congress.gov/bill/1?id=42');
  });

  it('sorts remaining params for stable canonicalization', () => {
    expect(canonicalizeUrl('https://sec.gov/path?b=2&a=1')).toBe('https://sec.gov/path?a=1&b=2');
  });

  it('produces identical canon for query-equivalent URLs', () => {
    const a = canonicalizeUrl('https://www.bls.gov/news.release/?utm_source=x&utm_medium=y');
    const b = canonicalizeUrl('https://bls.gov/news.release');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Handler — adapter iteration + classification + insert
// ---------------------------------------------------------------------------

interface FakeState {
  inserted: Record<string, unknown>[];
  insertedRejected: Record<string, unknown>[];
  payloadUpdates: { id: string; patch: Record<string, unknown> }[];
  insertError: { code?: string; message: string } | null;
}

function buildSupabase(state: FakeState): ServiceClient {
  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        // Mirror Postgres: an error response means the row did NOT land.
        // Only record successful inserts in state.inserted / state.insertedRejected.
        if (table === 'news_topics_candidates' && state.insertError === null) {
          if (row.rejected_reason) state.insertedRejected.push(row);
          else state.inserted.push(row);
        }
        return Promise.resolve({ error: state.insertError });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          if (table === 'scheduled_jobs') {
            state.payloadUpdates.push({ id: String(id), patch });
          }
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as ServiceClient;
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
    job_type: 'news_ingest',
    idempotency_key: '2026-06-16 12:00',
    target_user_id: null,
    payload: { emitted_at: '2026-06-16 12:00:00' },
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

function fakeAdapter(name: string, candidates: CandidateInput[]): NewsIngestAdapter {
  return {
    name,
    defaultCategory: 'congress',
    fetch: vi.fn().mockResolvedValue(candidates),
  };
}

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    source_provider: 'congress',
    source_category: 'congress',
    source_title: 'Senate passes HR-1234 52-48',
    source_url: 'https://www.congress.gov/bill/118hr1234',
    source_host: 'congress.gov',
    source_published_at: '2026-06-16T15:00:00Z',
    summary: 'Senate vote on HR-1234.',
    dedup_url_canon: 'https://congress.gov/bill/118hr1234',
    ...overrides,
  };
}

function freshState(): FakeState {
  return { inserted: [], insertedRejected: [], payloadUpdates: [], insertError: null };
}

describe('newsIngestHandler — happy path', () => {
  it('iterates all adapters and inserts allowed candidates', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [
      fakeAdapter('congress', [candidate()]),
      fakeAdapter('bls', [
        candidate({
          source_provider: 'bls',
          source_category: 'bls_labor',
          source_url: 'https://www.bls.gov/news.release/empsit.htm',
          source_host: 'bls.gov',
          dedup_url_canon: 'https://bls.gov/news.release/empsit.htm',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(2);
    expect(state.inserted[0]!.source_provider).toBe('congress');
    expect(state.inserted[1]!.source_provider).toBe('bls');
    expect(state.payloadUpdates).toHaveLength(1);
    const summary = state.payloadUpdates[0]!.patch.payload as {
      ingest_total_inserted: number;
    };
    expect(summary.ingest_total_inserted).toBe(2);
  });

  it('rejects non-allow-list URLs (host_not_allowed)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [
      fakeAdapter('congress', [
        candidate(), // allowed
        candidate({
          source_url: 'https://example.com/bogus',
          source_host: 'example.com',
          dedup_url_canon: 'https://example.com/bogus',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(1); // allowed only
    expect(state.insertedRejected).toHaveLength(1);
    expect(state.insertedRejected[0]!.rejected_reason).toBe('host_not_allowed');
  });

  it('classifies ban-list URLs as host_not_allowed (never primary)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    // A primary-source feed should never return a ban-list URL — this
    // test is defense in depth.
    const adapters = [
      fakeAdapter('congress', [
        candidate({
          source_url: 'https://www.cnn.com/politics/article/1',
          source_host: 'cnn.com',
          dedup_url_canon: 'https://cnn.com/politics/article/1',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(0);
    expect(state.insertedRejected).toHaveLength(1);
    expect(state.insertedRejected[0]!.rejected_reason).toBe('host_not_allowed');
  });

  it('one adapter failure does not kill the whole tick', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const failingAdapter: NewsIngestAdapter = {
      name: 'broken',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(new Error('feed 503')),
    };
    const goodAdapter = fakeAdapter('bls', [
      candidate({
        source_provider: 'bls',
        source_category: 'bls_labor',
        source_url: 'https://www.bls.gov/news.release/empsit.htm',
        source_host: 'bls.gov',
        dedup_url_canon: 'https://bls.gov/news.release/empsit.htm',
      }),
    ]);
    const handler = buildNewsIngestHandler([failingAdapter, goodAdapter]);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    // Good adapter still inserted its candidate.
    expect(state.inserted).toHaveLength(1);
    // Failure logged.
    expect(logger.calls.find((c) => c.obj.event === 'news_ingest.adapter_failed')).toBeDefined();
  });

  it('handles 23505 (unique violation) silently — re-ingest is expected', async () => {
    const state = freshState();
    state.insertError = { code: '23505', message: 'duplicate key value' };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [fakeAdapter('congress', [candidate()])];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    // No throw; the 23505 was absorbed as expected idempotency.
    expect(state.inserted).toHaveLength(0); // mock treats all inserts as failing
    const summary = state.payloadUpdates[0]!.patch.payload as {
      ingest_total_inserted: number;
    };
    expect(summary.ingest_total_inserted).toBe(0);
  });

  it('rejects http:// URLs (TLS required) as host_not_allowed', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [
      fakeAdapter('congress', [
        candidate({
          source_url: 'http://congress.gov/bill/1',
          source_host: 'congress.gov',
          dedup_url_canon: 'http://congress.gov/bill/1',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(0);
    expect(state.insertedRejected).toHaveLength(1);
  });
});
