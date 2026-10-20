import { describe, expect, it, vi } from 'vitest';

import {
  buildDropShadowDigestHandler,
  buildShadowTop5,
  digestDate,
  type ShadowTopEntry,
} from '../../../src/jobs/heat/digest.js';
import type { Env } from '../../../src/env.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../../src/supabase.js';

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
    HEAT_ENABLED: false,
    HEAT_SHADOW_ENABLED: false,
    ...overrides,
  } as Env;
}

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

function buildRow(): ScheduledJobRow {
  return {
    id: 'row-dig',
    job_type: 'drop_shadow_digest',
    idempotency_key: '2026-10-17',
    target_user_id: null,
    payload: { emitted_at: '2026-10-17 06:00:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: '2026-10-17T06:00:00Z',
    locked_at: '2026-10-17T06:00:01Z',
    locked_by: 'worker-test',
    last_error: null,
    processed_at: null,
    created_at: '2026-10-17T06:00:00Z',
    updated_at: '2026-10-17T06:00:00Z',
  };
}

describe('digestDate', () => {
  // Cron fires at 01:10 UTC. ET date depends on DST:
  //   EDT (UTC-4, Mar–Nov): 01:10 UTC on day D = 9:10 PM ET of day D-1
  //   EST (UTC-5, Nov–Mar): 01:10 UTC on day D = 8:10 PM ET of day D-1
  // The row's drop_date must be that ET-evening date — i.e., D-1 for
  // the cron firing moment, in both DST regimes.
  it('01:10 UTC in EDT (summer): pins to the previous UTC day in ET', () => {
    expect(digestDate(new Date('2026-10-19T01:10:00Z'))).toBe('2026-10-18');
  });

  it('01:10 UTC in EST (winter): pins to the previous UTC day in ET', () => {
    expect(digestDate(new Date('2026-12-20T01:10:00Z'))).toBe('2026-12-19');
  });

  it('crosses the UTC midnight boundary — not the ET-day boundary', () => {
    // 23:59 UTC day D (EDT = 19:59 ET of day D) and 00:01 UTC day D+1
    // (EDT = 20:01 ET of same day D) are both the same ET date.
    expect(digestDate(new Date('2026-10-18T23:59:00Z'))).toBe('2026-10-18');
    expect(digestDate(new Date('2026-10-19T00:01:00Z'))).toBe('2026-10-18');
  });

  it('EDT→EST transition (Nov 1 2026): 01:10 UTC on Nov 2 is still Nov 1 ET', () => {
    // EDT ends 2 AM local Sun 2026-11-01 → clocks fall back to 1 AM EST.
    // 01:10 UTC on Nov 2 → 20:10 EST on Nov 1.
    expect(digestDate(new Date('2026-11-02T01:10:00Z'))).toBe('2026-11-01');
  });
});

describe('buildShadowTop5', () => {
  it('maps rows, drops incomplete entries, caps at 5', () => {
    const rows = [
      {
        id: 'a',
        source_title: 'A',
        source_url: 'https://x/a',
        heat_score: 10,
        heat_components: { gdelt_term: 1 },
        global_event_id: 'G1',
      },
      {
        id: 'b',
        source_title: null, // dropped
        source_url: 'https://x/b',
        heat_score: 9,
        heat_components: null,
        global_event_id: null,
      },
      {
        id: 'c',
        source_title: 'C',
        source_url: 'https://x/c',
        heat_score: null, // dropped
        heat_components: null,
        global_event_id: null,
      },
      {
        id: 'd',
        source_title: 'D',
        source_url: 'https://x/d',
        heat_score: 8,
        heat_components: null,
        global_event_id: null,
      },
    ];
    const out: ShadowTopEntry[] = buildShadowTop5(rows);
    expect(out).toHaveLength(2);
    expect(out[0]!.candidate_id).toBe('a');
    expect(out[0]!.heat_components).toEqual({ gdelt_term: 1 });
    expect(out[1]!.candidate_id).toBe('d');
  });

  it('nulls source_url when it is not a well-formed http(s) URL', () => {
    const rows = [
      // Valid http
      {
        id: 'ok-http',
        source_title: 'OK HTTP',
        source_url: 'http://example.com/a',
        heat_score: 10,
        heat_components: null,
        global_event_id: null,
      },
      // Valid https
      {
        id: 'ok-https',
        source_title: 'OK HTTPS',
        source_url: 'https://example.com/b',
        heat_score: 9,
        heat_components: null,
        global_event_id: null,
      },
      // Non-http(s) scheme: dropped from URL field, row kept
      {
        id: 'js-scheme',
        source_title: 'JS',
        source_url: 'javascript:alert(1)',
        heat_score: 8,
        heat_components: null,
        global_event_id: null,
      },
      // Unparseable garbage
      {
        id: 'garbage',
        source_title: 'Garbage',
        source_url: 'not a url',
        heat_score: 7,
        heat_components: null,
        global_event_id: null,
      },
      // Missing url entirely
      {
        id: 'nullish',
        source_title: 'Nullish',
        source_url: null,
        heat_score: 6,
        heat_components: null,
        global_event_id: null,
      },
    ];
    const out = buildShadowTop5(rows);
    expect(out).toHaveLength(5);
    expect(out[0]!.source_url).toBe('http://example.com/a');
    expect(out[1]!.source_url).toBe('https://example.com/b');
    expect(out[2]!.source_url).toBeNull();
    expect(out[3]!.source_url).toBeNull();
    expect(out[4]!.source_url).toBeNull();
  });
});

describe('drop_shadow_digest handler', () => {
  function buildStampOnlyClient(stamped: { rowId: string; payload: Record<string, unknown> }[]) {
    const fromImpl = (table: string) => {
      if (table === 'scheduled_jobs') {
        return {
          update: (updateArg: Record<string, unknown>) => ({
            eq: (_c: string, rowId: string) => {
              const payload =
                (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
              stamped.push({ rowId, payload });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`fake: unexpected table ${table}`);
    };
    return { from: fromImpl } as unknown as ServiceClient;
  }

  it('HEAT_SHADOW_ENABLED=false (default, both flags off) short-circuits: no DB reads, stamps disabled', async () => {
    const stamped: { rowId: string; payload: Record<string, unknown> }[] = [];
    const client = buildStampOnlyClient(stamped);
    const logger = buildLogger();
    const handler = buildDropShadowDigestHandler({
      now: () => new Date('2026-10-17T06:00:00Z'),
      envProvider: () => env(),
    });
    await handler(buildRow(), { supabase: client, logger });
    expect(stamped[0]!.payload.outcome).toBe('disabled');
  });

  it('HEAT_ENABLED=true alone (no shadow): still stamps disabled — live flag is NOT the shadow gate', async () => {
    const stamped: { rowId: string; payload: Record<string, unknown> }[] = [];
    const client = buildStampOnlyClient(stamped);
    const logger = buildLogger();
    const handler = buildDropShadowDigestHandler({
      now: () => new Date('2026-10-17T06:00:00Z'),
      envProvider: () => env({ HEAT_ENABLED: true, HEAT_SHADOW_ENABLED: false }),
    });
    await handler(buildRow(), { supabase: client, logger });
    expect(stamped[0]!.payload.outcome).toBe('disabled');
  });

  it('HEAT_SHADOW_ENABLED=true + HEAT_ENABLED=false: queries real drop + top-5, calls RPC, stamps ok', async () => {
    const stamped: { rowId: string; payload: Record<string, unknown> }[] = [];
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
    const fromImpl = (table: string) => {
      if (table === 'scheduled_jobs') {
        return {
          update: (updateArg: Record<string, unknown>) => ({
            eq: (_c: string, rowId: string) => {
              const payload =
                (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
              stamped.push({ rowId, payload });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === 'news_topics') {
        return {
          select: () => ({
            eq: () => ({
              gt: () => ({
                lte: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({
                          data: {
                            id: 'topic-real',
                            drop_at: '2026-10-17T01:00:00Z',
                          },
                          error: null,
                        }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'news_topics_candidates') {
        return {
          select: () => ({
            not: () => ({
              gt: () => ({
                order: () => ({
                  limit: () =>
                    Promise.resolve({
                      data: [
                        {
                          id: 'cand-1',
                          source_title: 'Top candidate',
                          source_url: 'https://x/1',
                          heat_score: 42,
                          heat_components: { gdelt_term: 2.1 },
                          global_event_id: 'G-TOP',
                        },
                        {
                          id: 'cand-2',
                          source_title: 'Runner-up',
                          source_url: 'https://x/2',
                          heat_score: 30,
                          heat_components: null,
                          global_event_id: null,
                        },
                      ],
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`fake: unexpected table ${table}`);
    };
    const rpcImpl = (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ error: null });
    };
    const client = {
      from: fromImpl,
      rpc: rpcImpl,
    } as unknown as ServiceClient;
    const logger = buildLogger();
    const handler = buildDropShadowDigestHandler({
      now: () => new Date('2026-10-17T06:00:00Z'),
      envProvider: () => env({ HEAT_SHADOW_ENABLED: true }),
    });
    await handler(buildRow(), { supabase: client, logger });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.fn).toBe('record_drop_shadow_log');
    expect(rpcCalls[0]!.args.p_drop_date).toBe('2026-10-17');
    expect(rpcCalls[0]!.args.p_real_drop_topic_id).toBe('topic-real');
    const top = rpcCalls[0]!.args.p_shadow_top_5 as ShadowTopEntry[];
    expect(top).toHaveLength(2);
    expect(top[0]!.candidate_id).toBe('cand-1');
    expect(stamped[0]!.payload.outcome).toBe('ok');
    expect(stamped[0]!.payload.shadow_count).toBe(2);
  });

  it('no real Drop today: still records digest with real_drop_topic_id=null', async () => {
    const stamped: { rowId: string; payload: Record<string, unknown> }[] = [];
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
    const fromImpl = (table: string) => {
      if (table === 'scheduled_jobs') {
        return {
          update: (updateArg: Record<string, unknown>) => ({
            eq: (_c: string, rowId: string) => {
              const payload =
                (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
              stamped.push({ rowId, payload });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === 'news_topics') {
        return {
          select: () => ({
            eq: () => ({
              gt: () => ({
                lte: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () => Promise.resolve({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'news_topics_candidates') {
        return {
          select: () => ({
            not: () => ({
              gt: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`fake: unexpected table ${table}`);
    };
    const rpcImpl = (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ error: null });
    };
    const client = {
      from: fromImpl,
      rpc: rpcImpl,
    } as unknown as ServiceClient;
    const logger = buildLogger();
    const handler = buildDropShadowDigestHandler({
      now: () => new Date('2026-10-17T06:00:00Z'),
      envProvider: () => env({ HEAT_SHADOW_ENABLED: true }),
    });
    await handler(buildRow(), { supabase: client, logger });
    expect(rpcCalls[0]!.args.p_real_drop_topic_id).toBeNull();
    expect(rpcCalls[0]!.args.p_shadow_top_5 as unknown[]).toHaveLength(0);
    expect(stamped[0]!.payload.outcome).toBe('ok');
    expect(stamped[0]!.payload.real_drop_topic_id).toBeNull();
  });
});

void vi;
