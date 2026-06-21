import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';

import type { Context, RedisClient } from '../src/context.js';
import {
  aiSpendLimit,
  checkAndIncrementCombined,
  checkAndIncrementSingle,
  mutationLimit,
  publicLimit,
  queryLimit,
} from '../src/rate-limit.js';

import { fakeRedis, makeCtx } from './helpers.js';

// Build a fake Context for middleware tests.
function withRedis(
  evalReturn: unknown,
  ctxOverrides: Partial<Context> = {},
): { ctx: Context; redis: ReturnType<typeof fakeRedis> } {
  const redis = fakeRedis();
  redis.evalReturn = evalReturn;
  const ctx = makeCtx({
    db: {} as Context['db'],
    redis: redis as unknown as RedisClient,
    clientIpCidr: '198.51.100.0/24',
    ...ctxOverrides,
  });
  return { ctx, redis };
}

// tRPC `t.middleware(...)` returns a `MiddlewareBuilder`, not a callable
// function. To exercise it, we build a fresh tRPC instance, attach the
// middleware to a one-shot mutation procedure, and invoke it via
// `createCaller`. The procedure just returns 'ok' if it gets through.
// We get back { proceeded, error }: proceeded=true iff the handler ran,
// error=TRPCError iff the middleware threw.
const tTest = initTRPC.context<Context>().create({
  transformer: superjson,
});

async function runMiddleware(
  mw: ReturnType<typeof mutationLimit>,
  ctx: Context,
): Promise<{ proceeded: boolean; error: unknown }> {
  let proceeded = false;
  const procedure = tTest.procedure.use(mw).mutation(() => {
    proceeded = true;
    return 'ok';
  });
  const router = tTest.router({ test: procedure });
  try {
    await router.createCaller(ctx).test();
    return { proceeded, error: null };
  } catch (e) {
    return { proceeded, error: e };
  }
}

describe('checkAndIncrementSingle', () => {
  it('allows under-budget (current < limit) → allowed=true, current=N, ttl threaded', async () => {
    const redis = fakeRedis();
    // New Lua return shape: [cur, ttlSec].
    redis.evalReturn = [5, 42];
    const r = await checkAndIncrementSingle(redis, 'rl:test:k', 10, 60, true);
    expect(r).toEqual({ allowed: true, current: 5, retryAfterSec: 42, redisDown: false });
  });

  it('allows AT-budget (current === limit)', async () => {
    const redis = fakeRedis();
    redis.evalReturn = [10, 30];
    const r = await checkAndIncrementSingle(redis, 'rl:test:k', 10, 60, true);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(10);
    expect(r.retryAfterSec).toBe(30);
  });

  it('denies OVER-budget (current > limit) → allowed=false, retryAfter from TTL', async () => {
    const redis = fakeRedis();
    redis.evalReturn = [11, 17];
    const r = await checkAndIncrementSingle(redis, 'rl:test:k', 10, 60, true);
    expect(r.allowed).toBe(false);
    expect(r.current).toBe(11);
    expect(r.retryAfterSec).toBe(17);
  });

  it('accepts legacy single-number Lua return; ttl falls back to windowSec', async () => {
    const redis = fakeRedis();
    redis.evalReturn = 7; // legacy shape, missing ttl
    const r = await checkAndIncrementSingle(redis, 'rl:test:k', 10, 60, true);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(7);
    expect(r.retryAfterSec).toBe(60);
  });

  it('Redis-throw with failOpen=true → allowed=true, redisDown=true, retryAfter=windowSec', async () => {
    const redis: RedisClient = {
      ...fakeRedis(),

      eval: async () => {
        throw new Error('upstash REST timeout');
      },
    };
    const r = await checkAndIncrementSingle(redis, 'rl:test:k', 10, 60, true);
    expect(r).toEqual({
      allowed: true,
      current: -1,
      retryAfterSec: 60,
      redisDown: true,
    });
  });

  it('Redis-throw with failOpen=false → allowed=false, redisDown=true', async () => {
    const redis: RedisClient = {
      ...fakeRedis(),

      eval: async () => {
        throw new Error('upstash REST timeout');
      },
    };
    const r = await checkAndIncrementSingle(redis, 'rl:test:k', 10, 60, false);
    expect(r).toEqual({
      allowed: false,
      current: -1,
      retryAfterSec: 60,
      redisDown: true,
    });
  });
});

describe('checkAndIncrementCombined (aiSpend two-gate atomic)', () => {
  it('allowed when Lua returns [1, "", d, b, -1]; retryAfter is -1', async () => {
    const redis = fakeRedis();
    // New 5-tuple shape: [allowed, deniedBy, d, b, ttl].
    redis.evalReturn = [1, '', 5, 1, -1];
    const r = await checkAndIncrementCombined(redis, 'rl:ai:k:d', 'rl:ai:k:b', 20, 3, false);
    expect(r).toEqual({
      allowed: true,
      deniedBy: '',
      dailyCount: 5,
      burstCount: 1,
      retryAfterSec: -1,
      redisDown: false,
    });
  });

  it('denied by daily → retryAfter is the daily-key TTL (e.g. 70000s)', async () => {
    const redis = fakeRedis();
    // Daily denial: ttl is the remaining seconds on the daily key.
    redis.evalReturn = [0, 'daily', 20, 1, 70_000];
    const r = await checkAndIncrementCombined(redis, 'rl:ai:k:d', 'rl:ai:k:b', 20, 3, false);
    expect(r.allowed).toBe(false);
    expect(r.deniedBy).toBe('daily');
    expect(r.dailyCount).toBe(20);
    expect(r.burstCount).toBe(1);
    expect(r.retryAfterSec).toBe(70_000); // Not 60 — full daily-window remainder.
  });

  it('denied by burst → retryAfter is the burst-key TTL (e.g. 30s)', async () => {
    const redis = fakeRedis();
    redis.evalReturn = [0, 'burst', 5, 3, 30];
    const r = await checkAndIncrementCombined(redis, 'rl:ai:k:d', 'rl:ai:k:b', 20, 3, false);
    expect(r.allowed).toBe(false);
    expect(r.deniedBy).toBe('burst');
    expect(r.dailyCount).toBe(5);
    expect(r.burstCount).toBe(3);
    expect(r.retryAfterSec).toBe(30);
  });

  it('denied with ttl<=0 (Redis edge case) → retryAfter falls back to the window length', async () => {
    const redis = fakeRedis();
    redis.evalReturn = [0, 'daily', 20, 1, 0];
    const r = await checkAndIncrementCombined(redis, 'rl:ai:k:d', 'rl:ai:k:b', 20, 3, false);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBe(86_400); // DAILY_WINDOW_SEC fall-back
  });

  it('Redis-throw with failOpen=false → denied', async () => {
    const redis: RedisClient = {
      ...fakeRedis(),

      eval: async () => {
        throw new Error('upstash REST timeout');
      },
    };
    const r = await checkAndIncrementCombined(redis, 'd', 'b', 20, 3, false);
    expect(r.allowed).toBe(false);
    expect(r.redisDown).toBe(true);
  });
});

describe('mutationLimit (single-gate, fail-open)', () => {
  it('passes at the limit (current === limit)', async () => {
    const { ctx } = withRedis(30);
    const mw = mutationLimit('battles.submitAnswer', { perMin: 30 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });

  it('throws TOO_MANY_REQUESTS at limit+1', async () => {
    const { ctx } = withRedis(31);
    const mw = mutationLimit('battles.submitAnswer', { perMin: 30 });
    const r = await runMiddleware(mw, ctx);
    expect(r.proceeded).toBe(false);
    expect(r.error).toBeInstanceOf(TRPCError);
    expect((r.error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('fail-OPEN on Redis throw — proceeds without erroring', async () => {
    const redis = fakeRedis();
    redis.eval = async () => {
      throw new Error('upstash timeout');
    };
    const ctx = makeCtx({
      db: {} as Context['db'],
      redis: redis as unknown as RedisClient,
      clientIpCidr: '198.51.100.0/24',
    });
    const mw = mutationLimit('battles.submitAnswer', { perMin: 30 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });

  it('throws UNAUTHORIZED when ctx.userId is null', async () => {
    const { ctx } = withRedis(1, { userId: null });
    const mw = mutationLimit('battles.submitAnswer', { perMin: 30 });
    const r = await runMiddleware(mw, ctx);
    expect((r.error as TRPCError).code).toBe('UNAUTHORIZED');
  });
});

describe('publicLimit (IP-keyed, fail-open)', () => {
  it('passes at the limit', async () => {
    const { ctx } = withRedis(600);
    const mw = publicLimit('auth.session', { perMin: 600 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });

  it('throws TOO_MANY_REQUESTS at limit+1', async () => {
    const { ctx } = withRedis(601);
    const mw = publicLimit('auth.session', { perMin: 600 });
    const r = await runMiddleware(mw, ctx);
    expect((r.error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('fail-OPEN on Redis throw', async () => {
    const redis = fakeRedis();
    redis.eval = async () => {
      throw new Error('upstash timeout');
    };
    const ctx = makeCtx({
      db: {} as Context['db'],
      redis: redis as unknown as RedisClient,
      clientIpCidr: '198.51.100.0/24',
    });
    const mw = publicLimit('auth.session', { perMin: 600 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });
});

describe('aiSpendLimit (two-gate atomic, fail-closed)', () => {
  it('passes when Lua returns allowed', async () => {
    const { ctx } = withRedis([1, '', 5, 1]);
    const mw = aiSpendLimit('factCheck.enqueue', { daily: 20, burst: 3 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });

  it('throws TOO_MANY_REQUESTS when daily gate denies (daily-only-full)', async () => {
    // Daily is full (20/20), burst would still have room (1/3). Lua
    // checks daily first — must deny by daily.
    const { ctx } = withRedis([0, 'daily', 20, 1]);
    const mw = aiSpendLimit('factCheck.enqueue', { daily: 20, burst: 3 });
    const r = await runMiddleware(mw, ctx);
    expect(r.proceeded).toBe(false);
    expect((r.error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((r.error as TRPCError).message).toMatch(/daily/);
  });

  it('throws TOO_MANY_REQUESTS when burst gate denies (burst-only-full)', async () => {
    // Burst is full (3/3) inside the daily window where daily has
    // room (5/20). Lua checks daily-OK then burst-deny.
    const { ctx } = withRedis([0, 'burst', 5, 3]);
    const mw = aiSpendLimit('factCheck.enqueue', { daily: 20, burst: 3 });
    const r = await runMiddleware(mw, ctx);
    expect(r.proceeded).toBe(false);
    expect((r.error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((r.error as TRPCError).message).toMatch(/burst/);
  });

  it('fail-CLOSED on Redis throw — throws even though it could have allowed', async () => {
    const redis = fakeRedis();
    redis.eval = async () => {
      throw new Error('upstash timeout');
    };
    const ctx = makeCtx({
      db: {} as Context['db'],
      redis: redis as unknown as RedisClient,
      clientIpCidr: '198.51.100.0/24',
    });
    const mw = aiSpendLimit('factCheck.enqueue', { daily: 20, burst: 3 });
    const r = await runMiddleware(mw, ctx);
    expect(r.proceeded).toBe(false);
    expect((r.error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((r.error as TRPCError).message).toMatch(/unavailable/);
  });
});

describe('mutationLimit shared-key', () => {
  it('two procedures sharing a key build the same counter prefix', async () => {
    const { ctx, redis } = withRedis(1);
    const mw1 = mutationLimit('matchmaking.enqueue', { perMin: 20, sharedKey: 'matchmaking' });
    const mw2 = mutationLimit('matchmaking.cancel', { perMin: 20, sharedKey: 'matchmaking' });
    await runMiddleware(mw1, ctx);
    await runMiddleware(mw2, ctx);
    expect(redis.evalCalls.length).toBe(2);
    const key1 = redis.evalCalls[0]!.keys[0]!;
    const key2 = redis.evalCalls[1]!.keys[0]!;
    // Both use the shared 'matchmaking' segment, not the per-
    // procedure name. Window suffix may differ if the clock ticked
    // between calls; compare the prefix up to the window.
    const prefix1 = key1.split(':').slice(0, -1).join(':');
    const prefix2 = key2.split(':').slice(0, -1).join(':');
    expect(prefix1).toBe(prefix2);
    expect(prefix1).toMatch(/rl:mut:matchmaking:u:/);
  });
});

describe('queryLimit (M5.1 read-tier, single-gate, fail-open)', () => {
  it('passes at the limit (current === limit)', async () => {
    // SINGLE_GATE_LUA returns [cur, ttl]; the helper compares cur <= limit.
    const { ctx } = withRedis([180, 60]);
    const mw = queryLimit('battles.getRound', { perMin: 180 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });

  it('throws TOO_MANY_REQUESTS at limit+1', async () => {
    const { ctx } = withRedis([181, 60]);
    const mw = queryLimit('battles.getRound', { perMin: 180 });
    const r = await runMiddleware(mw, ctx);
    expect(r.proceeded).toBe(false);
    expect(r.error).toBeInstanceOf(TRPCError);
    expect((r.error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('keys on the `q` tier — separate namespace from mut', async () => {
    const { ctx, redis } = withRedis([1, 60]);
    const mw = queryLimit('battles.getRound', { perMin: 180 });
    await runMiddleware(mw, ctx);
    expect(redis.evalCalls.length).toBe(1);
    const key = redis.evalCalls[0]!.keys[0]!;
    // `rl:q:battles.getRound:u:user-123:<windowStart>`.
    expect(key).toMatch(/^rl:q:battles\.getRound:u:user-123:\d+$/);
    // Sibling shape: rl:mut:...:u:... should NOT appear in this key.
    expect(key).not.toMatch(/rl:mut:/);
  });

  it('threads TTL-based Retry-After through TRPCError.cause on deny', async () => {
    // Lua returns [cur=181, ttl=42] on deny; cause carries 42.
    const { ctx } = withRedis([181, 42]);
    const mw = queryLimit('debates.getBattle', { perMin: 90 });
    const r = await runMiddleware(mw, ctx);
    const cause = (r.error as TRPCError).cause as { retryAfterSec?: number } | undefined;
    expect(cause?.retryAfterSec).toBe(42);
  });

  it('fail-OPEN on Redis throw — proceeds without erroring', async () => {
    const redis = fakeRedis();
    redis.eval = async () => {
      throw new Error('upstash timeout');
    };
    const ctx = makeCtx({
      db: {} as Context['db'],
      redis: redis as unknown as RedisClient,
      clientIpCidr: '198.51.100.0/24',
    });
    const mw = queryLimit('debates.getBattle', { perMin: 90 });
    const r = await runMiddleware(mw, ctx);
    expect(r.error).toBe(null);
    expect(r.proceeded).toBe(true);
  });

  it('cross-user isolation: same procedure, different userIds → different keys', async () => {
    const { ctx: ctxA, redis: redisA } = withRedis([1, 60], { userId: 'user-A' });
    const { ctx: ctxB, redis: redisB } = withRedis([1, 60], { userId: 'user-B' });
    const mw = queryLimit('user.me', { perMin: 60 });
    await runMiddleware(mw, ctxA);
    await runMiddleware(mw, ctxB);
    const keyA = redisA.evalCalls[0]!.keys[0]!;
    const keyB = redisB.evalCalls[0]!.keys[0]!;
    expect(keyA).toMatch(/^rl:q:user\.me:u:user-A:\d+$/);
    expect(keyB).toMatch(/^rl:q:user\.me:u:user-B:\d+$/);
    expect(keyA).not.toBe(keyB);
  });

  it('throws UNAUTHORIZED when ctx.userId is null', async () => {
    const { ctx } = withRedis([1, 60], { userId: null });
    const mw = queryLimit('user.me', { perMin: 60 });
    const r = await runMiddleware(mw, ctx);
    expect((r.error as TRPCError).code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// PR #65 round-3 MEDIUM-2 — procedure-arg allowlist guard.
//
// `queryLimit` and `mutationLimit` embed the `procedure` string directly
// into the Redis key. A future caller passing a slash, colon, or
// whitespace-containing slug could silently redirect counter increments
// to a different tier/user namespace. The factory now throws at module-
// load time (when router files import + wire) if the slug doesn't match
// `/^[a-zA-Z][a-zA-Z0-9._-]*$/` — fail-fast at boot, never a malformed
// key at runtime. Symmetric to the UUID validation already applied to
// `userId` via `subjectSchema.parse()`.
//
// The factory body throws synchronously (Error, not TRPCError) — these
// asserts run before the returned middleware closure exists, so a bad
// slug never reaches the per-request path. Tests invoke the factories
// directly and assert throw/no-throw.
// ---------------------------------------------------------------------------
describe('PROCEDURE_RE allowlist — queryLimit / mutationLimit factory guard', () => {
  // Valid slugs accepted today by every wired call site.
  const VALID_SLUGS = [
    'wallet.balance',
    'wallet.transactions',
    'wallet.ghostEarnings',
    'debates.getBattle',
    'battles.getRound',
    'matchmaking.getStatus',
    'user.me',
    'feed.list',
    'factCheck.getVerdict',
    'pushSubscriptions.listMine',
    'pushSubs', // shared-key shape (no dot)
    'a',
    'A.b_C-d.1',
  ];

  // Each pattern targets a specific injection / corruption vector.
  const INVALID_SLUGS: Array<{ slug: string; reason: string }> = [
    { slug: '', reason: 'empty string — match-everything in patterns' },
    { slug: '1leadingDigit', reason: 'starts with digit' },
    { slug: '.leadingDot', reason: 'starts with dot' },
    { slug: '_leadingUnderscore', reason: 'starts with underscore (not in [a-zA-Z])' },
    { slug: 'has space', reason: 'whitespace' },
    {
      slug: 'tier:injection',
      reason: 'embedded colon — would corrupt rl:{tier}:{procedure}:... shape',
    },
    { slug: 'has/slash', reason: 'embedded slash' },
    { slug: 'wallet.balance\n', reason: 'trailing newline (log injection class)' },
    { slug: '*wildcard', reason: 'glob char — KEYS pattern hazard' },
  ];

  describe('queryLimit', () => {
    for (const slug of VALID_SLUGS) {
      it(`accepts valid slug "${slug}"`, () => {
        expect(() => queryLimit(slug, { perMin: 60 })).not.toThrow();
      });
    }

    for (const { slug, reason } of INVALID_SLUGS) {
      it(`rejects ${reason} (${JSON.stringify(slug)})`, () => {
        expect(() => queryLimit(slug, { perMin: 60 })).toThrow(/invalid procedure slug/);
      });
    }
  });

  describe('mutationLimit', () => {
    for (const slug of VALID_SLUGS) {
      it(`accepts valid slug "${slug}"`, () => {
        expect(() => mutationLimit(slug, { perMin: 10 })).not.toThrow();
      });
    }

    for (const { slug, reason } of INVALID_SLUGS) {
      it(`rejects ${reason} (${JSON.stringify(slug)})`, () => {
        expect(() => mutationLimit(slug, { perMin: 10 })).toThrow(/invalid procedure slug/);
      });
    }

    // sharedKey is the value that actually hits the Redis key when set —
    // the guard validates sharedKey precedence over procedure, not the
    // other way around. A clean procedure + bad sharedKey must still
    // throw; otherwise the injection survives via the shared-counter path.
    it('validates sharedKey precedence: clean procedure + malformed sharedKey throws', () => {
      expect(() =>
        mutationLimit('matchmaking.enqueue', { perMin: 20, sharedKey: 'bad:slug' }),
      ).toThrow(/invalid procedure slug/);
    });

    it('validates sharedKey precedence: clean procedure + clean sharedKey passes', () => {
      expect(() =>
        mutationLimit('matchmaking.enqueue', { perMin: 20, sharedKey: 'matchmaking' }),
      ).not.toThrow();
    });
  });
});
