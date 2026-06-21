import { afterEach, describe, expect, it } from 'vitest';

import { getOrBuildRedis, resetRedisCache } from '../src/context.js';
import type { Env } from '../src/env.js';

// ---------------------------------------------------------------------------
// PR #62 round-3 leftover #4 — `resetRedisCache()` escape hatch.
//
// `cachedRedis` is a module-level singleton in `apps/api/src/context.ts`
// that exact-once-constructs the Upstash REST client so a single
// process shares one HTTP connection pool. Unit tests today bypass the
// singleton entirely via `makeCtx({ redis: fakeRedis() })`, so the
// real singleton stays unreachable from the test environment. But any
// future integration test that calls `buildContext` directly would
// inherit a stale singleton across files — the cache survives test
// file boundaries because vitest runs files in the same worker
// process by default.
//
// `resetRedisCache()` is the escape hatch. This test pins that:
//   - Two consecutive `getOrBuildRedis(env)` calls return the same
//     instance (singleton holds).
//   - After `resetRedisCache()`, the next call returns a NEW instance
//     (rebuild forced).
//   - The hatch is always test-teardown-safe to call (idempotent —
//     calling it twice doesn't throw).
// ---------------------------------------------------------------------------

const TEST_ENV: Env = {
  PORT: 4000,
  HOST: '0.0.0.0',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_JWT_SECRET: 'jwt-secret',
  SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
  UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  WEB_ORIGINS: ['http://localhost:3000'],
  NODE_ENV: 'test',
};

// Test-teardown discipline: always reset between tests so this file's
// own assertions don't leak the cached instance to any later test that
// might import getOrBuildRedis. This is the recommended wiring for
// any test file that touches the real singleton.
afterEach(() => {
  resetRedisCache();
});

describe('resetRedisCache — Redis singleton escape hatch', () => {
  it('returns the same instance on consecutive getOrBuildRedis calls (singleton holds)', () => {
    const first = getOrBuildRedis(TEST_ENV);
    const second = getOrBuildRedis(TEST_ENV);
    expect(second).toBe(first);
  });

  it('forces a rebuild on the next call after resetRedisCache()', () => {
    const before = getOrBuildRedis(TEST_ENV);
    resetRedisCache();
    const after = getOrBuildRedis(TEST_ENV);
    // Different reference — proves the cache was actually cleared and a
    // fresh `new Redis({...})` ran, not a re-use of the cached value.
    expect(after).not.toBe(before);
  });

  it('resetRedisCache() is idempotent — safe to call twice', () => {
    resetRedisCache();
    expect(() => resetRedisCache()).not.toThrow();
  });

  it('resetRedisCache() is safe when no cache has been populated', () => {
    // Fresh `null` state. The escape hatch should be no-op-safe, not
    // throw on "nothing to reset" — important for `afterEach` teardown
    // discipline where the test may not have populated the cache.
    resetRedisCache();
    expect(() => resetRedisCache()).not.toThrow();
  });
});
