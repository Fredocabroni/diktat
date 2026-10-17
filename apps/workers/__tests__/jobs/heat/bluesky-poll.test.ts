import { describe, expect, it, vi } from 'vitest';

import {
  BLUESKY_TRENDING_URL,
  buildBlueskyTrendingPollHandler,
  normalizeTopicForSourceId,
  parseBlueskyTrendingBody,
  toUtcHourBucket,
} from '../../../src/jobs/heat/bluesky-poll.js';
import type { Env } from '../../../src/env.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../../src/supabase.js';

const SAMPLE_BODY = JSON.stringify({
  topics: [
    {
      topic: 'HR-1234',
      displayName: 'HR-1234 bill',
      description: 'Senate passes HR-1234',
      link: '/profile/politics/HR-1234',
    },
    {
      topic: 'Winter Weather',
      displayName: 'Winter Weather Forecast',
      description: 'storm hits Northeast',
      link: 'https://bsky.app/profile/weather',
    },
    {
      // Empty-topic row should be dropped.
      topic: '  ',
      displayName: 'Nothing',
    },
    {
      // Hostile scheme in `link` — accept the row but drop the link.
      topic: 'Hostile Link Row',
      displayName: 'oops',
      link: 'javascript:alert(1)',
    },
  ],
  suggested: [],
  recIdStr: 'abc',
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
  options?: { onConflict?: string; ignoreDuplicates?: boolean };
}
interface FakeStamp {
  rowId: string;
  payload: Record<string, unknown>;
}

function buildSupabase(opts?: { insertError?: { message: string } | null }): {
  client: ServiceClient;
  inserts: FakeInsert[];
  stamped: FakeStamp[];
} {
  const inserts: FakeInsert[] = [];
  const stamped: FakeStamp[] = [];
  const insertError = opts?.insertError ?? null;
  const fromImpl = (table: string) => {
    if (table === 'trend_signals') {
      return {
        upsert: (
          rows: ReadonlyArray<Record<string, unknown>>,
          options: { onConflict?: string; ignoreDuplicates?: boolean },
        ) => {
          inserts.push({ rows, options });
          return Promise.resolve({ error: insertError });
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

function buildRow(): ScheduledJobRow {
  return {
    id: 'row-bsky',
    job_type: 'bluesky_trending_poll',
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
    BLUESKY_ENABLED: false,
    ...overrides,
  } as Env;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('toUtcHourBucket', () => {
  it('bucket shape', () => {
    expect(toUtcHourBucket(new Date('2026-10-16T19:14:00Z'))).toBe('2026-10-16T19');
  });
});

describe('normalizeTopicForSourceId', () => {
  it('lowercases + collapses whitespace', () => {
    expect(normalizeTopicForSourceId('  Winter  Weather  ')).toBe('winter weather');
  });
});

describe('parseBlueskyTrendingBody', () => {
  it('parses topics; drops empty-topic row; strips hostile schemes from link', () => {
    const items = parseBlueskyTrendingBody(SAMPLE_BODY);
    expect(items).toHaveLength(3);
    expect(items[0]!.topic).toBe('HR-1234');
    expect(items[0]!.link).toBe('/profile/politics/HR-1234');
    expect(items[1]!.link).toBe('https://bsky.app/profile/weather');
    const hostile = items[2]!;
    expect(hostile.topic).toBe('Hostile Link Row');
    expect(hostile.link).toBeNull();
  });

  it('malformed JSON returns empty', () => {
    expect(parseBlueskyTrendingBody('not-json')).toEqual([]);
  });

  it('missing topics key returns empty', () => {
    expect(parseBlueskyTrendingBody(JSON.stringify({ other: 1 }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('bluesky_trending_poll handler', () => {
  it('disabled by default: stamps outcome=disabled, no fetch, no insert', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildBlueskyTrendingPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env(),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.inserts).toHaveLength(0);
    expect(supa.stamped).toHaveLength(1);
    expect(supa.stamped[0]!.payload.outcome).toBe('disabled');
  });

  it('enabled happy path: fetches, parses, inserts into trend_signals', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith(SAMPLE_BODY);
    const handler = buildBlueskyTrendingPollHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env({ BLUESKY_ENABLED: true }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      BLUESKY_TRENDING_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': expect.stringContaining('diktat') }),
      }),
    );
    expect(supa.inserts).toHaveLength(1);
    const rows = supa.inserts[0]!.rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.source).toBe('bluesky');
    expect(rows[0]!.source_id).toBe('hr-1234|2026-10-16T19');
    expect(supa.stamped[0]!.payload.outcome).toBe('ok');
    expect(supa.stamped[0]!.payload.fetched).toBe(3);
  });

  it('fetch 503: records degrade row, stamps degraded_fetch', async () => {
    const supa = buildSupabase();
    const logger = buildLogger();
    const fetchImpl = mockFetchWith('err', 503);
    const handler = buildBlueskyTrendingPollHandler({
      now: () => new Date('2026-10-16T19:15:00Z'),
      envProvider: () => env({ BLUESKY_ENABLED: true }),
    });
    await handler(buildRow(), { supabase: supa.client, logger, fetch: fetchImpl });
    expect(supa.inserts).toHaveLength(1);
    const row = supa.inserts[0]!.rows[0]!;
    expect((row.source_id as string).startsWith('__degraded__:')).toBe(true);
    expect(supa.stamped[0]!.payload.outcome).toBe('degraded_fetch');
  });
});

// Suppress unused-import warnings for vitest's `vi` in release builds.
void vi;
