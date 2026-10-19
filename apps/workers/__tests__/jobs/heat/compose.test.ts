import { describe, expect, it, vi } from 'vitest';

import {
  buildHeatComposeHandler,
  computeHeat,
  decayFactor,
  type MatchedSignal,
} from '../../../src/jobs/heat/compose.js';
import { DEFAULT_HEAT_WEIGHTS } from '../../../src/jobs/heat/weights.js';
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
    id: 'row-compose',
    job_type: 'heat_compose',
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

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe('decayFactor', () => {
  it('age 0 → 1.0', () => {
    expect(decayFactor(0, 12)).toBe(1.0);
  });
  it('age = half-life → 0.5', () => {
    expect(decayFactor(12, 12)).toBeCloseTo(0.5, 5);
  });
  it('age = 2× half-life → 0.25', () => {
    expect(decayFactor(24, 12)).toBeCloseTo(0.25, 5);
  });
  it('future-dated cluster clamps to 1.0', () => {
    expect(decayFactor(-5, 12)).toBe(1.0);
  });
});

describe('computeHeat', () => {
  const now = Date.parse('2026-10-16T19:00:00Z');

  it('zero signals + fresh cluster → gdelt term only, no cross bonus', () => {
    const r = computeHeat({
      cluster: { distinct_outlets: 5, last_seen_at_ms: now }, // decay = 1.0
      signals: [],
      nowMs: now,
    });
    expect(r.components.decay).toBe(1.0);
    expect(r.components.google_term).toBe(0);
    expect(r.components.cross_bonus).toBe(0);
    expect(r.heat_score).toBeCloseTo(DEFAULT_HEAT_WEIGHTS.w_g * Math.log1p(5), 5);
  });

  it('google_term from max approx_traffic', () => {
    const signals: MatchedSignal[] = [
      { source: 'google_trends', payload: { approx_traffic: 20000 } },
      { source: 'google_trends', payload: { approx_traffic: 500 } },
    ];
    const r = computeHeat({
      cluster: { distinct_outlets: 0, last_seen_at_ms: now },
      signals,
      nowMs: now,
    });
    expect(r.components.google_term).toBeCloseTo(DEFAULT_HEAT_WEIGHTS.w_gt * Math.log1p(20000), 5);
  });

  it('x_term: tweet_volume preferred over presence when available', () => {
    const vol: MatchedSignal[] = [
      { source: 'x_trends', payload: { tweet_volume: 1000 } },
      { source: 'x_trends', payload: { tweet_volume: 500 } },
    ];
    const r = computeHeat({
      cluster: { distinct_outlets: 0, last_seen_at_ms: now },
      signals: vol,
      nowMs: now,
    });
    expect(r.components.x_term).toBeCloseTo(DEFAULT_HEAT_WEIGHTS.w_x * Math.log1p(1500), 5);

    const presenceOnly: MatchedSignal[] = [
      { source: 'x_trends', payload: {} },
      { source: 'x_trends', payload: {} },
    ];
    const r2 = computeHeat({
      cluster: { distinct_outlets: 0, last_seen_at_ms: now },
      signals: presenceOnly,
      nowMs: now,
    });
    expect(r2.components.x_term).toBeCloseTo(DEFAULT_HEAT_WEIGHTS.w_x * Math.log1p(2), 5);
  });

  it('bsky_term: boolean (one or many → same +w_bsk)', () => {
    const r = computeHeat({
      cluster: { distinct_outlets: 0, last_seen_at_ms: now },
      signals: [{ source: 'bluesky', payload: { topic: 'x' } }],
      nowMs: now,
    });
    expect(r.components.bsky_term).toBeCloseTo(DEFAULT_HEAT_WEIGHTS.w_bsk, 5);
  });

  it('wikimedia_pageviews is validation-only — never contributes', () => {
    const r = computeHeat({
      cluster: { distinct_outlets: 0, last_seen_at_ms: now },
      signals: [{ source: 'wikimedia_pageviews', payload: { views: 1_000_000 } }],
      nowMs: now,
    });
    expect(r.components.matched_sources).toBe(0);
    expect(r.components.cross_bonus).toBe(0);
    expect(r.heat_score).toBe(0);
  });

  it('cross-source bonus fires at ≥ threshold distinct sources', () => {
    const r = computeHeat({
      cluster: { distinct_outlets: 3, last_seen_at_ms: now },
      signals: [
        { source: 'google_trends', payload: { approx_traffic: 100 } },
        { source: 'x_trends', payload: { tweet_volume: 100 } },
      ],
      nowMs: now,
    });
    expect(r.components.matched_sources).toBe(2);
    expect(r.components.cross_bonus).toBe(DEFAULT_HEAT_WEIGHTS.w_cross);
  });

  it('degraded sentinel signals do not count as a matched source', () => {
    const r = computeHeat({
      cluster: { distinct_outlets: 3, last_seen_at_ms: now },
      signals: [
        { source: 'google_trends', payload: { degraded: true } },
        { source: 'bluesky', payload: { topic: 'x' } },
      ],
      nowMs: now,
    });
    expect(r.components.matched_sources).toBe(1);
    expect(r.components.cross_bonus).toBe(0);
  });

  it('decay dampens an old cluster', () => {
    const old = now - 24 * 3600 * 1000; // 24h ago → decay = 0.25
    const r = computeHeat({
      cluster: { distinct_outlets: 10, last_seen_at_ms: old },
      signals: [],
      nowMs: now,
    });
    expect(r.components.decay).toBeCloseTo(0.25, 5);
    expect(r.heat_score).toBeCloseTo(DEFAULT_HEAT_WEIGHTS.w_g * Math.log1p(10) * 0.25, 5);
  });

  it('reddit term is zero-weighted today (approval DEFERRED)', () => {
    const r = computeHeat({
      cluster: { distinct_outlets: 0, last_seen_at_ms: now },
      signals: [{ source: 'reddit', payload: { score: 10000, upvote_ratio: 0.95 } }],
      nowMs: now,
    });
    expect(DEFAULT_HEAT_WEIGHTS.w_r).toBe(0);
    expect(r.components.reddit_term).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Handler disabled path
// ---------------------------------------------------------------------------

describe('heat_compose handler (shadow gates)', () => {
  it('HEAT_ENABLED=false: no DB reads, stamps disabled', async () => {
    const stamped: { rowId: string; payload: Record<string, unknown> }[] = [];
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
    const client = { from: fromImpl } as unknown as ServiceClient;
    const logger = buildLogger();
    const handler = buildHeatComposeHandler({
      now: () => new Date('2026-10-16T19:00:00Z'),
      envProvider: () => env(),
    });
    await handler(buildRow(), { supabase: client, logger });
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.payload.outcome).toBe('disabled');
  });
});

void vi;
