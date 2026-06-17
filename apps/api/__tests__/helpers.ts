import type { Context, RedisClient } from '../src/context.js';
import type { Env } from '../src/env.js';

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

/**
 * In-memory Redis stand-in implementing the `RedisClient` surface. Used
 * by router tests that touch the matchmaking sorted set. The store is
 * fresh per call to `fakeRedis()`.
 */
export function fakeRedis(): RedisClient & {
  zset: Map<string, Map<string, number>>;
  kv: Map<string, string>;
} {
  const zset = new Map<string, Map<string, number>>();
  const kv = new Map<string, string>();

  function getZset(key: string): Map<string, number> {
    let s = zset.get(key);
    if (!s) {
      s = new Map();
      zset.set(key, s);
    }
    return s;
  }

  return {
    zset,
    kv,
    async zadd(key, sm) {
      getZset(key).set(sm.member, sm.score);
      return 1;
    },
    async zrem(key, ...members) {
      const s = getZset(key);
      let n = 0;
      for (const m of members) {
        if (s.delete(m)) n += 1;
      }
      return n;
    },
    async zscore(key, member) {
      const v = getZset(key).get(member);
      return v ?? null;
    },
    async set(key, value, _opts) {
      kv.set(key, value);
      return 'OK';
    },
    async get(key) {
      const v = kv.get(key);
      return v === undefined ? null : v;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (kv.delete(k)) n += 1;
        if (zset.delete(k)) n += 1;
      }
      return n;
    },
  };
}

/**
 * Build a fake Supabase query builder. The fluent chain is captured so
 * tests can assert filter usage; the terminal `maybeSingle`, `then`, etc.
 * resolve to `result`.
 */
export interface FakeQueryResult<T> {
  data: T | null;
  error: { code?: string; message: string } | null;
}

export function fakeDb<T>(table: string, result: FakeQueryResult<T>) {
  const calls: { table: string; ops: { op: string; args: unknown[] }[] } = { table, ops: [] };

  const builder: Record<string, unknown> = {};

  const resolveValue = result;
  // Methods that return the builder for chaining.
  for (const op of [
    'select',
    'eq',
    'lt',
    'lte',
    'gt',
    'gte',
    'order',
    'limit',
    'update',
    'insert',
    'upsert',
    'delete',
  ]) {
    builder[op] = (...args: unknown[]) => {
      calls.ops.push({ op, args });
      return builder;
    };
  }
  // Terminal methods.
  builder.maybeSingle = () => Promise.resolve(resolveValue);
  builder.single = () => Promise.resolve(resolveValue);
  builder.then = (resolve: (v: FakeQueryResult<T>) => unknown) =>
    Promise.resolve(resolve(resolveValue));

  const db = {
    from: (t: string) => {
      if (t !== table) {
        throw new Error(`fakeDb: unexpected table "${t}", expected "${table}"`);
      }
      return builder;
    },
  };

  return { db, calls };
}

/**
 * Construct a tRPC context with sensible defaults for tests. Pass a fake
 * Supabase client built via `fakeDb` to drive responses.
 */
export function makeCtx(overrides: Partial<Context> & { db: unknown }): Context {
  return {
    env: TEST_ENV,
    userId: 'user-123',
    role: 'authenticated',
    bearerToken: 'fake-token',
    redis: fakeRedis(),
    ...(overrides as Partial<Context>),
    db: overrides.db as Context['db'],
  };
}
