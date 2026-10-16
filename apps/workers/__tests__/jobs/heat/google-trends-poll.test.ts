import { describe, expect, it, vi } from 'vitest';

import {
  buildGoogleTrendsPollHandler,
  GOOGLE_TRENDS_RSS_URL,
  normalizeSourceIdTitle,
  parseApproxTraffic,
  parseGoogleTrendsRss,
  toUtcHourBucket,
} from '../../../src/jobs/heat/google-trends-poll.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../../src/supabase.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <title>Trending now (US)</title>
    <item>
      <title>winter weather forecast</title>
      <ht:approx_traffic>200000+</ht:approx_traffic>
      <pubDate>Fri, 16 Oct 2026 15:00:00 -0400</pubDate>
      <ht:picture>https://example.com/a.png</ht:picture>
      <ht:picture_source>Example Weather</ht:picture_source>
      <ht:news_item>
        <ht:news_item_title>Winter storm hits Northeast</ht:news_item_title>
        <ht:news_item_url>https://www.apnews.com/winter-storm-northeast</ht:news_item_url>
        <ht:news_item_source>AP News</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Snow blankets Boston</ht:news_item_title>
        <ht:news_item_url>https://www.reuters.com/snow-boston</ht:news_item_url>
        <ht:news_item_source>Reuters</ht:news_item_source>
      </ht:news_item>
    </item>
    <item>
      <title>power outage tacoma</title>
      <ht:approx_traffic>5000+</ht:approx_traffic>
      <pubDate>Fri, 16 Oct 2026 14:30:00 -0400</pubDate>
      <ht:news_item>
        <ht:news_item_title>Thousands without power in Tacoma</ht:news_item_title>
        <ht:news_item_url>https://www.king5.com/tacoma-outage</ht:news_item_url>
        <ht:news_item_source>KING 5</ht:news_item_source>
      </ht:news_item>
    </item>
    <item>
      <title>  </title>
      <ht:approx_traffic>100+</ht:approx_traffic>
      <pubDate>Fri, 16 Oct 2026 14:00:00 -0400</pubDate>
    </item>
  </channel>
</rss>`;

// ---------------------------------------------------------------------------
// Helpers
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

interface FakeInsert {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly options: { onConflict?: string; ignoreDuplicates?: boolean } | undefined;
}

interface FakeSupabase {
  readonly client: ServiceClient;
  readonly inserts: FakeInsert[];
  readonly stamped: Array<{ rowId: string; payload: Record<string, unknown> }>;
  insertError: { message: string } | null;
}

function buildSupabase(initial?: { insertError?: { message: string } | null }): FakeSupabase {
  const state: {
    inserts: FakeInsert[];
    stamped: Array<{ rowId: string; payload: Record<string, unknown> }>;
    insertError: { message: string } | null;
  } = {
    inserts: [],
    stamped: [],
    insertError: initial?.insertError ?? null,
  };

  const fromImpl = (table: string) => {
    if (table === 'trend_signals') {
      return {
        upsert: (
          rows: ReadonlyArray<Record<string, unknown>>,
          options: { onConflict?: string; ignoreDuplicates?: boolean },
        ) => {
          state.inserts.push({ rows, options });
          return Promise.resolve({ error: state.insertError });
        },
      };
    }
    if (table === 'scheduled_jobs') {
      return {
        update: (updateArg: Record<string, unknown>) => ({
          eq: (_col: string, rowId: string) => {
            // Unwrap: the handler calls .update({ payload: {...} }),
            // so the inner `payload` column value is what the test
            // asserts on. Fallback for safety if a future caller
            // updates other columns.
            const payload = (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
            state.stamped.push({ rowId, payload });
            return Promise.resolve({ error: null });
          },
        }),
      };
    }
    throw new Error(`fake supabase: unexpected table ${table}`);
  };

  return {
    client: { from: fromImpl } as unknown as ServiceClient,
    get inserts() {
      return state.inserts;
    },
    get stamped() {
      return state.stamped;
    },
    get insertError() {
      return state.insertError;
    },
    set insertError(v: { message: string } | null) {
      state.insertError = v;
    },
  };
}

function buildRow(id = 'row-1'): ScheduledJobRow {
  return {
    id,
    job_type: 'google_trends_poll',
    idempotency_key: '2026-10-16 15:00',
    target_user_id: null,
    payload: { emitted_at: '2026-10-16 15:00:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: '2026-10-16T15:00:00Z',
    locked_at: '2026-10-16T15:00:01Z',
    locked_by: 'worker-test',
    last_error: null,
    processed_at: null,
    created_at: '2026-10-16T15:00:00Z',
    updated_at: '2026-10-16T15:00:00Z',
  };
}

function mockFetchWith(body: string, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (delivered) return { value: undefined, done: true };
              delivered = true;
              return { value: bytes, done: false };
            },
            cancel: async () => {
              /* noop */
            },
          };
        },
      },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

function mockFetchThrowing(err: Error): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw err;
  }) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// parseApproxTraffic
// ---------------------------------------------------------------------------

describe('parseApproxTraffic', () => {
  it('parses "200+" → 200', () => {
    expect(parseApproxTraffic('200+')).toBe(200);
  });
  it('parses "200000+" → 200000', () => {
    expect(parseApproxTraffic('200000+')).toBe(200000);
  });
  it('parses bare integer "1000" → 1000', () => {
    expect(parseApproxTraffic('1000')).toBe(1000);
  });
  it('strips surrounding whitespace', () => {
    expect(parseApproxTraffic('  5000+  ')).toBe(5000);
  });
  it('strips thousands commas', () => {
    expect(parseApproxTraffic('1,000+')).toBe(1000);
  });
  it('returns null on empty / null', () => {
    expect(parseApproxTraffic('')).toBeNull();
    expect(parseApproxTraffic(null)).toBeNull();
    expect(parseApproxTraffic(undefined)).toBeNull();
  });
  it('returns null on non-numeric', () => {
    expect(parseApproxTraffic('many')).toBeNull();
    expect(parseApproxTraffic('+')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseGoogleTrendsRss
// ---------------------------------------------------------------------------

describe('parseGoogleTrendsRss', () => {
  it('parses the sample feed into normalized items', async () => {
    const items = await parseGoogleTrendsRss(SAMPLE_FEED);
    // The empty-title item is dropped; two valid items remain.
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('winter weather forecast');
    expect(items[0]!.approxTraffic).toBe(200000);
    expect(items[0]!.newsItems).toHaveLength(2);
    expect(items[0]!.newsItems[0]!.url).toBe('https://www.apnews.com/winter-storm-northeast');
    expect(items[0]!.newsItems[0]!.source).toBe('AP News');
    expect(items[1]!.title).toBe('power outage tacoma');
    expect(items[1]!.approxTraffic).toBe(5000);
    expect(items[1]!.newsItems).toHaveLength(1);
  });

  it('handles a feed with no items', async () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`;
    const items = await parseGoogleTrendsRss(empty);
    expect(items).toEqual([]);
  });

  it('caps pubDate at 64 chars (hostile-feed defense)', async () => {
    const longDate = 'A'.repeat(500);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <item>
      <title>long date trend</title>
      <ht:approx_traffic>100+</ht:approx_traffic>
      <pubDate>${longDate}</pubDate>
    </item>
  </channel>
</rss>`;
    const items = await parseGoogleTrendsRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]!.pubDate).not.toBeNull();
    expect(items[0]!.pubDate!.length).toBe(64);
  });

  it('skips news_items whose url is not http(s) (javascript:/data:/file:)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <item>
      <title>scheme guard trend</title>
      <ht:approx_traffic>500+</ht:approx_traffic>
      <pubDate>Fri, 16 Oct 2026 15:00:00 -0400</pubDate>
      <ht:news_item>
        <ht:news_item_title>Hostile link</ht:news_item_title>
        <ht:news_item_url>javascript:alert(1)</ht:news_item_url>
        <ht:news_item_source>Attacker</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Data URI</ht:news_item_title>
        <ht:news_item_url>data:text/html,&lt;script&gt;x()&lt;/script&gt;</ht:news_item_url>
        <ht:news_item_source>Attacker</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>File URI</ht:news_item_title>
        <ht:news_item_url>file:///etc/passwd</ht:news_item_url>
        <ht:news_item_source>Attacker</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Protocol-relative</ht:news_item_title>
        <ht:news_item_url>//example.com/x</ht:news_item_url>
        <ht:news_item_source>Attacker</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Legit https</ht:news_item_title>
        <ht:news_item_url>https://www.apnews.com/legit</ht:news_item_url>
        <ht:news_item_source>AP News</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Legit http</ht:news_item_title>
        <ht:news_item_url>http://plain.example.com/x</ht:news_item_url>
        <ht:news_item_source>Plain</ht:news_item_source>
      </ht:news_item>
    </item>
  </channel>
</rss>`;
    const items = await parseGoogleTrendsRss(xml);
    expect(items).toHaveLength(1);
    const urls = items[0]!.newsItems.map((n) => n.url);
    expect(urls).toEqual(['https://www.apnews.com/legit', 'http://plain.example.com/x']);
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('google_trends_poll handler', () => {
  it('happy path: fetches, parses, inserts items into trend_signals', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith(SAMPLE_FEED);
    const handler = buildGoogleTrendsPollHandler({ now: () => new Date('2026-10-16T19:00:00Z') });
    const row = buildRow();

    await handler(row, {
      supabase: supabase.client,
      logger,
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      GOOGLE_TRENDS_RSS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': expect.stringContaining('diktat') }),
      }),
    );
    expect(supabase.inserts).toHaveLength(1);
    const insert = supabase.inserts[0]!;
    expect(insert.rows).toHaveLength(2);
    expect(insert.options).toMatchObject({
      onConflict: 'source,source_id',
      ignoreDuplicates: true,
    });
    expect(insert.rows[0]!.source).toBe('google_trends');
    expect(insert.rows[0]!.source_id).toBe('winter weather forecast|2026-10-16T19');
    expect((insert.rows[0]!.payload as Record<string, unknown>).approx_traffic).toBe(200000);
    expect((insert.rows[0]!.payload as Record<string, unknown>).news_items).toHaveLength(2);
    expect((insert.rows[0]!.payload as Record<string, unknown>).bucket_utc_hour).toBe(
      '2026-10-16T19',
    );

    const completeLog = logger.calls.find((c) => c.obj.event === 'google_trends_poll.complete');
    expect(completeLog).toBeDefined();
    expect(completeLog!.obj.fetched).toBe(2);
  });

  it('fetch non-2xx: records a single degrade row + stamps outcome', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith('server error', 503);
    const handler = buildGoogleTrendsPollHandler({ now: () => new Date('2026-10-16T19:15:00Z') });
    const row = buildRow('row-degrade');

    await handler(row, {
      supabase: supabase.client,
      logger,
      fetch: fetchImpl,
    });

    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.inserts[0]!.rows).toHaveLength(1);
    const degradeRow = supabase.inserts[0]!.rows[0]!;
    expect(degradeRow.source).toBe('google_trends');
    expect((degradeRow.source_id as string).startsWith('__degraded__:')).toBe(true);
    expect((degradeRow.payload as Record<string, unknown>).degraded).toBe(true);
    expect((degradeRow.payload as Record<string, unknown>).reason).toContain('fetch returned 503');

    expect(supabase.stamped).toHaveLength(1);
    expect(supabase.stamped[0]!.payload.outcome).toBe('degraded_fetch');
  });

  it('fetch throws: records a degrade and does not throw out of the handler', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchThrowing(new Error('ECONNREFUSED'));
    const handler = buildGoogleTrendsPollHandler({ now: () => new Date('2026-10-16T19:30:00Z') });
    const row = buildRow('row-throw');

    await expect(
      handler(row, {
        supabase: supabase.client,
        logger,
        fetch: fetchImpl,
      }),
    ).resolves.toBeUndefined();

    expect(supabase.inserts).toHaveLength(1);
    expect((supabase.inserts[0]!.rows[0]!.payload as Record<string, unknown>).reason).toContain(
      'ECONNREFUSED',
    );
  });

  it('insert error degrades silently (logged, not thrown)', async () => {
    const supabase = buildSupabase({ insertError: { message: 'db unavailable' } });
    const logger = buildLogger();
    const fetchImpl = mockFetchWith(SAMPLE_FEED);
    const handler = buildGoogleTrendsPollHandler({ now: () => new Date('2026-10-16T19:45:00Z') });
    const row = buildRow('row-insert-err');

    await expect(
      handler(row, {
        supabase: supabase.client,
        logger,
        fetch: fetchImpl,
      }),
    ).resolves.toBeUndefined();

    // Insert attempt still logged + stamped as 'ok' with inserted_failed = row count.
    const warn = logger.calls.find((c) => c.obj.event === 'google_trends_poll.insert_failed');
    expect(warn).toBeDefined();
    expect(supabase.stamped[0]!.payload.outcome).toBe('ok');
    expect(supabase.stamped[0]!.payload.inserted_failed).toBe(2);
  });

  it('missing fetch impl throws', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const handler = buildGoogleTrendsPollHandler();
    const row = buildRow('row-nofetch');

    // Capture the real global fetch and remove it for this test.
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      await expect(
        handler(row, {
          supabase: supabase.client,
          logger,
          fetch: undefined,
        }),
      ).rejects.toThrow(/no fetch implementation/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// source_id time-bucket contract
// ---------------------------------------------------------------------------

describe('source_id time-bucket (UTC-hour)', () => {
  it('toUtcHourBucket formats as YYYY-MM-DDTHH', () => {
    expect(toUtcHourBucket(new Date('2026-10-16T19:00:00Z'))).toBe('2026-10-16T19');
    expect(toUtcHourBucket(new Date('2026-10-16T19:14:59.999Z'))).toBe('2026-10-16T19');
    expect(toUtcHourBucket(new Date('2026-10-16T20:00:00Z'))).toBe('2026-10-16T20');
    expect(toUtcHourBucket(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00');
  });

  it('normalizeSourceIdTitle lowercases + collapses whitespace', () => {
    expect(normalizeSourceIdTitle('Winter Weather Forecast')).toBe('winter weather forecast');
    expect(normalizeSourceIdTitle('  Winter   Weather\tForecast  ')).toBe(
      'winter weather forecast',
    );
  });

  it('same title in two different hours writes two rows; same hour writes one', async () => {
    // Three ticks of the SAME two trending titles, at:
    //   T1 = 19:00 UTC
    //   T2 = 19:14 UTC (same hour as T1)
    //   T3 = 20:00 UTC (next hour)
    // Expected: T1 writes 2 rows (bucket …T19). T2 writes 2 rows into
    // trend_signals, but the real DB would collapse them via the
    // unique(source,source_id) index — the fake Supabase doesn't
    // enforce the index, so this test asserts source_id EQUALITY
    // between T1 and T2 rows (what the index collapses on) and
    // INEQUALITY between T1/T2 and T3 rows (what forces new rows).

    const supabase = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith(SAMPLE_FEED);

    const tickAt = async (iso: string): Promise<void> => {
      const handler = buildGoogleTrendsPollHandler({ now: () => new Date(iso) });
      await handler(buildRow(`row-${iso}`), {
        supabase: supabase.client,
        logger,
        fetch: fetchImpl,
      });
    };

    await tickAt('2026-10-16T19:00:00Z');
    await tickAt('2026-10-16T19:14:00Z');
    await tickAt('2026-10-16T20:00:00Z');

    expect(supabase.inserts).toHaveLength(3);
    const idsAt = (tickIdx: number): string[] =>
      supabase.inserts[tickIdx]!.rows.map((r) => r.source_id as string);

    // T1 and T2 are in the same UTC hour → identical source_ids
    // (the live unique index collapses them to one row apiece).
    expect(idsAt(0)).toEqual(idsAt(1));
    expect(idsAt(0)).toEqual([
      'winter weather forecast|2026-10-16T19',
      'power outage tacoma|2026-10-16T19',
    ]);

    // T3 crosses the hour → fresh source_ids, distinct from T1/T2.
    expect(idsAt(2)).toEqual([
      'winter weather forecast|2026-10-16T20',
      'power outage tacoma|2026-10-16T20',
    ]);
    for (const id of idsAt(2)) {
      expect(idsAt(0)).not.toContain(id);
    }
  });
});
