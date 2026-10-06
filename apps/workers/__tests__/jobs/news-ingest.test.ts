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

const { canonicalizeUrl, fetchAndParseRss } = __testing;

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
// fetchAndParseRss — redirect host validation (SSRF defense)
// ---------------------------------------------------------------------------

describe('fetchAndParseRss — redirect host validation', () => {
  // Minimal RSS body, returned on 200 to satisfy the parser when a test
  // exercises a happy redirect-followed-to-an-allow-list-host case.
  const RSS_OK = `<?xml version="1.0"?><rss version="2.0"><channel><title>ok</title><item><title>x</title><link>https://www.congress.gov/bill/1</link></item></channel></rss>`;

  it('rejects a 302 redirect to a non-allow-list host (the SSRF case)', async () => {
    // Hardcoded primary-source feed URL respondes with 302 to evil.com.
    // The workers process must NOT issue the follow-up fetch.
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'https://www.congress.gov/rss/feed.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.com/feed.xml' },
        });
      }
      // If this branch fires, the SSRF defense failed.
      throw new Error(`unexpected follow-up fetch to ${u}`);
    });

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.congress.gov/rss/feed.xml'),
    ).rejects.toThrow(/refusing to fetch non-primary host: https:\/\/evil\.com/);

    // Hard assertion: only ONE fetch was made — the original. The
    // redirect was never followed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a 301 redirect to a ban-listed host (CNN as framing-only)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'https://www.bls.gov/feed/news_release.rss') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://www.cnn.com/politics/rss' },
        });
      }
      throw new Error(`unexpected follow-up fetch to ${u}`);
    });

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.bls.gov/feed/news_release.rss'),
    ).rejects.toThrow(/refusing to fetch non-primary host: https:\/\/www\.cnn\.com/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a 301 redirect WITHIN the allow-list (e.g. www.bls.gov → bls.gov)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'https://www.bls.gov/feed/news_release.rss') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://bls.gov/feed/news_release.rss' },
        });
      }
      if (u === 'https://bls.gov/feed/news_release.rss') {
        return new Response(RSS_OK, { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });

    const items = await fetchAndParseRss(
      fetchImpl as never,
      'https://www.bls.gov/feed/news_release.rss',
    );
    expect(items.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an infinite redirect loop (>MAX_REDIRECTS)', async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      return new Response(null, {
        status: 302,
        // Same-host redirect chain; allow-list passes each time but
        // the depth cap kills the loop.
        headers: { location: `https://www.congress.gov/rss/feed-${count}.xml` },
      });
    });

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.congress.gov/rss/feed-0.xml'),
    ).rejects.toThrow(/redirect chain too long/);
  });

  it('rejects 3xx with no Location header (malformed redirect)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: {} }));

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.sec.gov/news/pressreleases.rss'),
    ).rejects.toThrow(/302 from .* carried no Location header/);
  });

  it('refuses to fetch a non-allow-list feed URL at all (pre-fetch host gate)', async () => {
    // Defense in depth — if a future adapter is misconfigured with a
    // non-primary feed URL, the host gate blocks the request entirely.
    const fetchImpl = vi.fn();
    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://news.example.com/rss'),
    ).rejects.toThrow(/refusing to fetch non-primary host: https:\/\/news\.example\.com/);
    expect(fetchImpl).not.toHaveBeenCalled();
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
  /** news_adapter_health upserts (adapter → latest payload). The handler
   *  calls upsert on every tick; the Map models the PK on `adapter`. */
  healthUpserts: Map<string, Record<string, unknown>>;
  /** Prior-row snapshot the handler reads via
   *  `select(...).eq('adapter', name).maybeSingle()` before each upsert.
   *  Tests can prime this to simulate a pre-existing adapter row (e.g.
   *  to verify the fresh-at timestamp carries forward across a dead
   *  tick without being cleared). */
  healthPriors: Map<string, Record<string, unknown>>;
  /** Rows the handler's bulk-read `select(...)` returns for the
   *  warnStaleAdapters pass. Separate from `healthPriors` because the
   *  terminal select and the eq()-filtered select serve different
   *  code paths. */
  healthBulkRows: Record<string, unknown>[];
}

function buildSupabase(state: FakeState): ServiceClient {
  return {
    from: (table: string) => {
      // news_adapter_health has a different write shape (upsert instead
      // of insert) and two read shapes (eq-filtered single + terminal
      // bulk). Model each explicitly rather than through the generic
      // from() shape so the test doesn't accidentally conflate paths.
      if (table === 'news_adapter_health') {
        return {
          select: (_cols: string) => {
            // Terminal thenable (await supabase.from(...).select(...))
            // returns the bulk rows for warnStaleAdapters, AND
            // .eq('adapter', name).maybeSingle() returns the prior-row
            // snapshot for upsertAdapterHealth.
            return {
              eq: (col: string, val: unknown) => ({
                maybeSingle: () => {
                  const data =
                    col === 'adapter' ? (state.healthPriors.get(String(val)) ?? null) : null;
                  return Promise.resolve({ data, error: null });
                },
              }),
              then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
                resolve({ data: state.healthBulkRows, error: null }),
            };
          },
          upsert: (row: Record<string, unknown>, _opts?: unknown) => {
            state.healthUpserts.set(String(row.adapter), row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
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
      };
    },
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
  return {
    inserted: [],
    insertedRejected: [],
    payloadUpdates: [],
    insertError: null,
    healthUpserts: new Map(),
    healthPriors: new Map(),
    healthBulkRows: [],
  };
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

// ---------------------------------------------------------------------------
// news_adapter_health UPSERT + 24h staleness warn (PR follow-up to #154)
// ---------------------------------------------------------------------------

describe('news_adapter_health — per-adapter liveness tracking', () => {
  it('upserts last_success_at and last_fresh_insert_at when a candidate lands', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [fakeAdapter('congress', [candidate()])];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const health = state.healthUpserts.get('congress');
    expect(health).toBeDefined();
    expect(health!.last_success_at).toBeTypeOf('string');
    expect(health!.last_fresh_insert_at).toBeTypeOf('string');
    expect(health!.last_fetched_count).toBe(1);
    expect(health!.last_fresh_count).toBe(1);
    expect(health!.last_error_at).toBeNull();
  });

  it('does NOT advance last_fresh_insert_at when every row 23505-collides', async () => {
    const state = freshState();
    state.insertError = { code: '23505', message: 'duplicate key value' };
    // Prior row: adapter succeeded and produced fresh rows 2 hours ago.
    // The current tick re-ingests the same items (dedup absorbs them)
    // so last_fresh_insert_at MUST hold still — exactly the condition
    // the 24h-dedup warn is designed to catch.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.healthPriors.set('congress', {
      last_success_at: twoHoursAgo,
      last_fresh_insert_at: twoHoursAgo,
      last_error_at: null,
      last_error_message: null,
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [fakeAdapter('congress', [candidate()])];
    const handler = buildNewsIngestHandler(adapters);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const health = state.healthUpserts.get('congress');
    expect(health).toBeDefined();
    // last_success_at advances (fetch itself succeeded) but
    // last_fresh_insert_at stays frozen at the two-hour-ago prior.
    expect(health!.last_success_at).not.toBe(twoHoursAgo);
    expect(health!.last_fresh_insert_at).toBe(twoHoursAgo);
    expect(health!.last_fresh_count).toBe(0);
  });

  it('stamps last_error_at + last_error_message on adapter.fetch failure; preserves last_success_at', async () => {
    const state = freshState();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.healthPriors.set('broken', {
      last_success_at: twoHoursAgo,
      last_fresh_insert_at: twoHoursAgo,
      last_error_at: null,
      last_error_message: null,
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const broken: NewsIngestAdapter = {
      name: 'broken',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(new Error('feed 503')),
    };
    const handler = buildNewsIngestHandler([broken]);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const health = state.healthUpserts.get('broken');
    expect(health).toBeDefined();
    expect(health!.last_error_at).toBeTypeOf('string');
    expect(health!.last_error_message).toBe('feed 503');
    // A failing fetch MUST NOT clear last_success_at — it holds the
    // last-known-good signal while the current tick is in a bad state.
    expect(health!.last_success_at).toBe(twoHoursAgo);
    expect(health!.last_fresh_insert_at).toBe(twoHoursAgo);
    expect(health!.last_fetched_count).toBe(0);
  });

  it('emits adapter_stale warn when last_fresh_insert_at >= 24h old', async () => {
    const state = freshState();
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Bulk-read result for warnStaleAdapters: one adapter stale, one fresh.
    state.healthBulkRows = [
      {
        adapter: 'bls',
        last_success_at: new Date().toISOString(),
        last_fresh_insert_at: twentyFiveHoursAgo,
        updated_at: twentyFiveHoursAgo,
      },
      {
        adapter: 'congress',
        last_success_at: new Date().toISOString(),
        last_fresh_insert_at: halfHourAgo,
        updated_at: halfHourAgo,
      },
    ];
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildNewsIngestHandler([fakeAdapter('congress', [candidate()])]);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const warns = logger.calls.filter((c) => c.obj.event === 'news_ingest.adapter_stale');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj.adapter).toBe('bls');
    expect(warns[0]!.level).toBe('warn');
  });

  it('does NOT warn when last_fresh_insert_at is null AND the row is <24h old (cold-start grace)', async () => {
    const state = freshState();
    state.healthBulkRows = [
      {
        adapter: 'brand_new',
        last_success_at: null,
        last_fresh_insert_at: null,
        // Row created 5 minutes ago — brand new adapter, hasn't had a
        // chance to produce anything yet. A warn here would false-fire
        // on every new adapter rollout.
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    ];
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildNewsIngestHandler([fakeAdapter('brand_new', [candidate()])]);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(logger.calls.find((c) => c.obj.event === 'news_ingest.adapter_stale')).toBeUndefined();
  });

  it('DOES warn when last_fresh_insert_at is null AND the row is >=24h old', async () => {
    const state = freshState();
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    state.healthBulkRows = [
      {
        adapter: 'never_fresh',
        last_success_at: twentyFiveHoursAgo,
        last_fresh_insert_at: null,
        updated_at: twentyFiveHoursAgo,
      },
    ];
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildNewsIngestHandler([fakeAdapter('never_fresh', [candidate()])]);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const warns = logger.calls.filter((c) => c.obj.event === 'news_ingest.adapter_stale');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj.adapter).toBe('never_fresh');
  });
});
