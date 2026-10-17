import { describe, expect, it, vi } from 'vitest';

import {
  buildWikimediaValidateHandler,
  parseWikimediaBody,
  WIKIMEDIA_PAGEVIEWS_BASE,
  wikimediaUrl,
  yesterdayUtcParts,
} from '../../../src/jobs/heat/wikimedia-validate.js';
import type { Env } from '../../../src/env.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../../src/supabase.js';

const SAMPLE_BODY = JSON.stringify({
  items: [
    {
      project: 'en.wikipedia',
      access: 'all-access',
      year: '2026',
      month: '10',
      day: '15',
      articles: [
        { article: 'Main_Page', views: 6_269_720, rank: 1 }, // meta, dropped
        { article: 'GBU-43/B_MOAB', views: 500_000, rank: 2 },
        { article: 'Special:Search', views: 400_000, rank: 3 }, // dropped
        { article: 'Winter_storm_2026', views: 350_000, rank: 4 },
        { article: 'Portal:Current_events', views: 300_000, rank: 5 }, // dropped
        { article: 'Wikipedia:Random', views: 250_000, rank: 6 }, // dropped
        { article: '-', views: 200_000, rank: 7 }, // dropped
        { article: 'HR-1234', views: 150_000, rank: 8 },
        { article: 'Senate', views: 100_000, rank: 9 },
      ],
    },
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

function buildSupabase(): {
  client: ServiceClient;
  inserts: FakeInsert[];
  stamped: FakeStamp[];
} {
  const inserts: FakeInsert[] = [];
  const stamped: FakeStamp[] = [];
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
            const payload = (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
            stamped.push({ rowId, payload });
            return Promise.resolve({ error: null });
          },
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
    id: 'row-wm',
    job_type: 'wikimedia_pageviews_validate',
    idempotency_key: '2026-10-16',
    target_user_id: null,
    payload: { emitted_at: '2026-10-16 10:00:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: '2026-10-16T10:00:00Z',
    locked_at: '2026-10-16T10:00:01Z',
    locked_by: 'worker-test',
    last_error: null,
    processed_at: null,
    created_at: '2026-10-16T10:00:00Z',
    updated_at: '2026-10-16T10:00:00Z',
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
    WIKIMEDIA_ENABLED: false,
    ...overrides,
  } as Env;
}

describe('yesterdayUtcParts', () => {
  it('returns yesterday in UTC with zero-padded parts', () => {
    const parts = yesterdayUtcParts(new Date('2026-01-01T05:00:00Z'));
    expect(parts).toEqual({ year: '2025', month: '12', day: '31', iso: '2025-12-31' });
  });
});

describe('wikimediaUrl', () => {
  it('joins base path with year/month/day', () => {
    expect(wikimediaUrl('2026', '10', '15')).toBe(`${WIKIMEDIA_PAGEVIEWS_BASE}/2026/10/15`);
  });
});

describe('parseWikimediaBody', () => {
  it('drops meta pages (Main_Page, Special:, Portal:, Wikipedia:, -) and keeps news-ish rows', () => {
    const items = parseWikimediaBody(SAMPLE_BODY);
    expect(items.map((i) => i.article)).toEqual([
      'GBU-43/B_MOAB',
      'Winter_storm_2026',
      'HR-1234',
      'Senate',
    ]);
    expect(items[0]!.views).toBe(500_000);
    expect(items[0]!.rank).toBe(2);
  });

  it('malformed JSON returns empty', () => {
    expect(parseWikimediaBody('x')).toEqual([]);
  });
  it('empty items returns empty', () => {
    expect(parseWikimediaBody(JSON.stringify({ items: [] }))).toEqual([]);
  });
});

describe('wikimedia_pageviews_validate handler', () => {
  it('disabled by default: no fetch, no insert, stamps disabled', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildWikimediaValidateHandler({
      now: () => new Date('2026-10-16T10:00:00Z'),
      envProvider: () => env(),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.inserts).toHaveLength(0);
    expect(supa.stamped[0]!.payload.outcome).toBe('disabled');
  });

  it('enabled: fetches yesterday-UTC URL, inserts top-N skipping meta pages', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith(SAMPLE_BODY);
    const handler = buildWikimediaValidateHandler({
      now: () => new Date('2026-10-16T10:00:00Z'),
      envProvider: () => env({ WIKIMEDIA_ENABLED: true }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      wikimediaUrl('2026', '10', '15'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'user-agent': expect.stringContaining('Diktat'),
        }),
      }),
    );
    expect(supa.inserts).toHaveLength(1);
    const rows = supa.inserts[0]!.rows;
    expect(rows).toHaveLength(4);
    expect(rows[0]!.source).toBe('wikimedia_pageviews');
    expect(rows[0]!.source_id).toBe('en.wikipedia:GBU-43/B_MOAB:2026-10-15');
    expect(supa.stamped[0]!.payload.outcome).toBe('ok');
    expect(supa.stamped[0]!.payload.date_fetched).toBe('2026-10-15');
  });

  it('fetch 500: degraded_fetch, no inserts', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith('err', 500);
    const handler = buildWikimediaValidateHandler({
      now: () => new Date('2026-10-16T10:00:00Z'),
      envProvider: () => env({ WIKIMEDIA_ENABLED: true }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(supa.inserts).toHaveLength(0);
    expect(supa.stamped[0]!.payload.outcome).toBe('degraded_fetch');
  });
});

void vi;
