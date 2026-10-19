import { describe, expect, it, vi } from 'vitest';

import {
  buildXTrendsPollHandler,
  normalizeTrendForSourceId,
  parseXTrendsBody,
  toUtcHourBucket,
  X_TRENDS_URL,
  X_TRENDS_US_WOEID,
} from '../../../src/jobs/heat/x-trends-poll.js';
import type { Env } from '../../../src/env.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../../src/supabase.js';

// Fixtures. The X v2 docs.x.com example shape wraps items in `data`
// and lists only `trend_name`; some tiers may add `tweet_volume`.

const FIXTURE_NO_VOLUME = JSON.stringify({
  data: [
    { trend_name: '#AI' },
    { trend_name: 'HR-1234' },
    { trend_name: '  ' }, // dropped
  ],
});

const FIXTURE_WITH_VOLUME = JSON.stringify({
  data: [
    { trend_name: '#AI', tweet_volume: 12345 },
    { trend_name: 'HR-1234', tweet_volume: 0 },
    { trend_name: 'nullvol', tweet_volume: null },
    { trend_name: 'badvol', tweet_volume: -5 }, // dropped from vol → null
  ],
});

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
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
  };
}

interface FakeInsert {
  rows: ReadonlyArray<Record<string, unknown>>;
}
interface FakeStamp {
  rowId: string;
  payload: Record<string, unknown>;
}

function buildSupabase(opts?: { callsToday?: number }): {
  client: ServiceClient;
  inserts: FakeInsert[];
  stamped: FakeStamp[];
} {
  const inserts: FakeInsert[] = [];
  const stamped: FakeStamp[] = [];
  const callsToday = opts?.callsToday ?? 0;
  const fromImpl = (table: string) => {
    if (table === 'trend_signals') {
      return {
        upsert: (rows: ReadonlyArray<Record<string, unknown>>) => {
          inserts.push({ rows });
          return Promise.resolve({ error: null });
        },
      };
    }
    if (table === 'scheduled_jobs') {
      // Two chains: .update(...).eq('id', rowId) for stamp,
      // and .select(...).eq('job_type').gte('created_at').lte('created_at') for countCallsToday.
      return {
        update: (updateArg: Record<string, unknown>) => ({
          eq: (_col: string, rowId: string) => {
            const payload = (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
            stamped.push({ rowId, payload });
            return Promise.resolve({ error: null });
          },
        }),
        select: (_cols: string) => ({
          eq: (_c1: string, _v1: string) => ({
            gte: (_c2: string, _v2: string) => ({
              lte: (_c3: string, _v3: string) =>
                Promise.resolve({
                  data: Array.from({ length: callsToday }, () => ({ payload: { outcome: 'ok' } })),
                  error: null,
                }),
            }),
          }),
        }),
      };
    }
    throw new Error(`fake: unexpected table ${table}`);
  };
  return { client: { from: fromImpl } as unknown as ServiceClient, inserts, stamped };
}

function mockFetchWith(body: string, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => {
    const bytes = new TextEncoder().encode(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { value: undefined, done: true };
              done = true;
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

function buildRow(): ScheduledJobRow {
  return {
    id: 'row-x',
    job_type: 'x_trends_poll',
    idempotency_key: '2026-10-16 19',
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

function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'https://example.com',
    SUPABASE_URL: 'https://example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'x',
    UPSTASH_REDIS_REST_URL: 'https://example.com',
    UPSTASH_REDIS_REST_TOKEN: 'x',
    PRIVY_ENABLED: false,
    PRIVY_APP_ID: '',
    PRIVY_APP_SECRET: '',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: '',
    GDELT_ENABLED: false,
    X_TRENDS_ENABLED: false,
    X_BEARER_TOKEN: '',
    ...overrides,
  } as Env;
}

describe('X_TRENDS_US_WOEID + URL', () => {
  it('US WOEID is 23424977 and URL embeds it', () => {
    expect(X_TRENDS_US_WOEID).toBe(23424977);
    expect(X_TRENDS_URL).toContain('23424977');
    expect(X_TRENDS_URL.startsWith('https://api.x.com/2/trends/by/woeid/')).toBe(true);
  });
});

describe('parseXTrendsBody', () => {
  it('data[] shape, trend_name only — drops empty trend_name', () => {
    const items = parseXTrendsBody(FIXTURE_NO_VOLUME);
    expect(items).toHaveLength(2);
    expect(items[0]!.trend_name).toBe('#AI');
    expect(items[0]!.tweet_volume).toBeNull();
    expect(items[1]!.trend_name).toBe('HR-1234');
    expect(items[1]!.tweet_volume).toBeNull();
  });

  it('data[] shape with tweet_volume — accepts non-negative integers, nulls negatives/non-numbers', () => {
    const items = parseXTrendsBody(FIXTURE_WITH_VOLUME);
    expect(items).toHaveLength(4);
    expect(items[0]!.tweet_volume).toBe(12345);
    expect(items[1]!.tweet_volume).toBe(0);
    expect(items[2]!.tweet_volume).toBeNull();
    expect(items[3]!.tweet_volume).toBeNull();
  });

  it('tolerates `trends` key as fallback for schema drift', () => {
    const items = parseXTrendsBody(JSON.stringify({ trends: [{ trend_name: 'x' }] }));
    expect(items).toHaveLength(1);
  });

  it('malformed JSON returns empty', () => {
    expect(parseXTrendsBody('not-json')).toEqual([]);
  });
});

describe('x_trends_poll handler', () => {
  it('disabled by default: no fetch, no insert, stamps disabled', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildXTrendsPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env(),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.inserts).toHaveLength(0);
    expect(supa.stamped[0]!.payload.outcome).toBe('disabled');
  });

  it('enabled but no bearer: outcome=no_bearer, no fetch', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildXTrendsPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env({ X_TRENDS_ENABLED: true, X_BEARER_TOKEN: '' }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.stamped[0]!.payload.outcome).toBe('no_bearer');
  });

  it('enabled with bearer: fetches with Authorization header, inserts items', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith(FIXTURE_WITH_VOLUME);
    const handler = buildXTrendsPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env({ X_TRENDS_ENABLED: true, X_BEARER_TOKEN: 'test-bearer-xxx' }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      X_TRENDS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-bearer-xxx',
        }),
      }),
    );
    expect(supa.inserts).toHaveLength(1);
    const rows = supa.inserts[0]!.rows;
    expect(rows).toHaveLength(4);
    expect(rows[0]!.source).toBe('x_trends');
    expect(rows[0]!.source_id).toBe('#ai|2026-10-16T19');
    expect((rows[0]!.payload as Record<string, unknown>).tweet_volume).toBe(12345);
    expect(supa.stamped[0]!.payload.outcome).toBe('ok');
  });

  it('countCallsToday DB error: fail CLOSED with outcome=degraded_count, no fetch', async () => {
    // scheduled_jobs.select returns an error. Build a minimal fake
    // supabase whose stamp path still works (so we can read the
    // outcome back) but whose select rejects with an error.
    const stamped: FakeStamp[] = [];
    const inserts: FakeInsert[] = [];
    const fromImpl = (table: string) => {
      if (table === 'trend_signals') {
        return {
          upsert: (rows: ReadonlyArray<Record<string, unknown>>) => {
            inserts.push({ rows });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'scheduled_jobs') {
        return {
          update: (updateArg: Record<string, unknown>) => ({
            eq: (_col: string, rowId: string) => {
              const payload =
                (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
              stamped.push({ rowId, payload });
              return Promise.resolve({ error: null });
            },
          }),
          select: (_cols: string) => ({
            eq: (_c1: string, _v1: string) => ({
              gte: (_c2: string, _v2: string) => ({
                lte: (_c3: string, _v3: string) =>
                  Promise.resolve({
                    data: null,
                    error: { message: 'simulated DB failure' },
                  }),
              }),
            }),
          }),
        };
      }
      throw new Error(`fake: unexpected table ${table}`);
    };
    const client = { from: fromImpl } as unknown as ServiceClient;
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildXTrendsPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env({ X_TRENDS_ENABLED: true, X_BEARER_TOKEN: 'x' }),
    });
    await handler(buildRow(), { supabase: client, logger, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.payload.outcome).toBe('degraded_count');
  });

  it('daily cap trips when 48 ok calls already recorded', async () => {
    const supa = buildSupabase({ callsToday: 48 });
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildXTrendsPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env({ X_TRENDS_ENABLED: true, X_BEARER_TOKEN: 'x' }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.stamped[0]!.payload.outcome).toBe('daily_cap_hit');
  });

  it('fetch 401 (bearer invalid): outcome=degraded_fetch, no inserts to trend_signals', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith('{"error":"unauthorized"}', 401);
    const handler = buildXTrendsPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env({ X_TRENDS_ENABLED: true, X_BEARER_TOKEN: 'bad' }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(supa.inserts).toHaveLength(0);
    expect(supa.stamped[0]!.payload.outcome).toBe('degraded_fetch');
  });
});

describe('normalizeTrendForSourceId', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeTrendForSourceId('  #AI   Research  ')).toBe('#ai research');
  });
});

describe('toUtcHourBucket', () => {
  it('matches YYYY-MM-DDTHH', () => {
    expect(toUtcHourBucket(new Date('2026-10-16T19:00:00Z'))).toBe('2026-10-16T19');
  });
});

void vi;
