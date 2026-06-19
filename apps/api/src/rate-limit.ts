// M5 — tRPC rate-limit middleware factories + the shared Lua scripts.
//
// Three factories share two Lua scripts. Each factory returns a
// `t.middleware(...)` that chains off `protectedProcedure` /
// `publicProcedure`; per-procedure budgets live at the call site
// alongside the procedure definition so the budget table is
// auditable in one spot.
//
//   aiSpendLimit({ daily, burst })  — TWO counters per request,
//                                      check-then-INCR (deny does
//                                      NOT increment). FAIL-CLOSED:
//                                      a Redis outage 429s the call
//                                      rather than leak $1+ of AI
//                                      spend. Used by factCheck.enqueue.
//
//   mutationLimit({ perMin, sharedKey? })
//                                    — SINGLE counter, INCR-then-check
//                                      (deny DOES increment). FAIL-OPEN:
//                                      a Redis outage logs and lets the
//                                      mutation through. Used by every
//                                      authed mutation. `sharedKey` lets
//                                      `matchmaking.enqueue`+`cancel`
//                                      and `pushSubscriptions.register`+
//                                      `unregister` share one counter.
//
//   publicLimit({ perMin })          — Same shape as mutationLimit, but
//                                      keyed by `ctx.clientIpCidr`
//                                      (the /24 IPv4 or /64 IPv6
//                                      group) instead of `ctx.userId`.
//                                      Used by auth.session +
//                                      tribes.list.
//
// Key shape: rl:{tier}:{procedure}:{subject}:{windowStart}
//   - tier      = ai | mut | pub
//   - procedure = the tRPC path slug, or a `sharedKey` for combined budgets
//   - subject   = u:{userId} for authed tiers; ip:{CIDR} for public tier
//   - windowStart = floor(epochMs / windowMs) — embedded so processes
//                   share the same window without coordination
//
// Deny semantics:
//   - The SINGLE-gate factories (mutationLimit, publicLimit) use
//     INCR-then-check. The atomic INCR fires BEFORE the limit check,
//     so a denied call INCREMENTS the counter (cur lands at limit+1).
//     Practical impact: a user who hits 31/min on battles.submitAnswer
//     sees the next call 429. The 32nd attempt would also see 429 and
//     push the counter to 33. Counter resets when the window expires.
//     This is by-design — the alternative (atomic check-then-INCR via
//     Lua) costs one extra Lua round-trip for the simple case and
//     buys nothing operationally for general mutations.
//   - The COMBINED-atomic factory (aiSpendLimit) uses check-then-INCR
//     across BOTH counters atomically inside Lua. A denied call does
//     NOT increment EITHER counter — necessary because the daily
//     window is 86400s; allowing the 21st call (deny) to push the
//     daily counter to 21 would mean the user is now over-counted for
//     the rest of the day even if their next attempt is days later
//     after the counter was supposed to roll over.

import { TRPCError } from '@trpc/server';

import type { RedisClient } from './context.js';
import { middleware } from './trpc.js';

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

// Single-gate fixed-window: INCR-then-check semantics in the CALLER
// (Lua only does the atomic INCR+EXPIRE). The TS layer compares the
// returned counter to the limit. Denied calls increment the counter.
const SINGLE_GATE_LUA = `
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return cur
`.trim();

// Combined-atomic two-gate fixed-window: check-then-INCR semantics
// across BOTH counters. Returns {allowed, deniedBy, dailyCount,
// burstCount} so the caller can build a precise error message.
// KEYS[1] = daily key, KEYS[2] = burst key.
// ARGV: dailyLimit, dailyWindowSec, burstLimit, burstWindowSec.
const COMBINED_ATOMIC_LUA = `
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
local b = tonumber(redis.call('GET', KEYS[2]) or '0')
local d_limit = tonumber(ARGV[1])
local b_limit = tonumber(ARGV[3])
if d >= d_limit then return {0, 'daily', d, b} end
if b >= b_limit then return {0, 'burst', d, b} end
d = redis.call('INCR', KEYS[1])
if d == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
b = redis.call('INCR', KEYS[2])
if b == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
return {1, '', d, b}
`.trim();

// ---------------------------------------------------------------------------
// Window-start computation
// ---------------------------------------------------------------------------

const MS_PER_SEC = 1_000;

function windowStart(nowMs: number, windowSec: number): number {
  return Math.floor(nowMs / (windowSec * MS_PER_SEC));
}

// Day window for AI spend: align to UTC day boundary so the user's
// daily budget rolls over at midnight UTC, not on a sliding 24h.
const DAILY_WINDOW_SEC = 86_400;
const BURST_WINDOW_SEC = 60;
const MUTATION_WINDOW_SEC = 60;
const PUBLIC_WINDOW_SEC = 60;

// ---------------------------------------------------------------------------
// Shared checkAndIncrement helpers — exported for the Fastify outer hook
// in server.ts to reuse without going through tRPC.
// ---------------------------------------------------------------------------

export interface SingleGateResult {
  readonly allowed: boolean;
  readonly current: number;
  /** True if the helper short-circuited due to a thrown Redis error. */
  readonly redisDown: boolean;
}

export async function checkAndIncrementSingle(
  redis: RedisClient,
  key: string,
  limit: number,
  windowSec: number,
  failOpen: boolean,
): Promise<SingleGateResult> {
  try {
    const raw = await redis.eval(SINGLE_GATE_LUA, [key], [windowSec]);
    const current = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(current)) {
      // Bad return — treat as Redis-down and use failOpen policy.
      return { allowed: failOpen, current: -1, redisDown: true };
    }
    return { allowed: current <= limit, current, redisDown: false };
  } catch {
    // Upstash REST timeout / network / parse error.
    return { allowed: failOpen, current: -1, redisDown: true };
  }
}

export interface CombinedGateResult {
  readonly allowed: boolean;
  readonly deniedBy: 'daily' | 'burst' | '';
  readonly dailyCount: number;
  readonly burstCount: number;
  readonly redisDown: boolean;
}

export async function checkAndIncrementCombined(
  redis: RedisClient,
  dailyKey: string,
  burstKey: string,
  dailyLimit: number,
  burstLimit: number,
  failOpen: boolean,
): Promise<CombinedGateResult> {
  try {
    const raw = (await redis.eval(
      COMBINED_ATOMIC_LUA,
      [dailyKey, burstKey],
      [dailyLimit, DAILY_WINDOW_SEC, burstLimit, BURST_WINDOW_SEC],
    )) as [number | string, string, number | string, number | string];
    if (!Array.isArray(raw) || raw.length !== 4) {
      return {
        allowed: failOpen,
        deniedBy: '',
        dailyCount: -1,
        burstCount: -1,
        redisDown: true,
      };
    }
    const allowedRaw = Number(raw[0]);
    const allowed = allowedRaw === 1;
    const deniedBy =
      (raw[1] as string) === 'daily' || (raw[1] as string) === 'burst'
        ? (raw[1] as 'daily' | 'burst')
        : '';
    return {
      allowed,
      deniedBy,
      dailyCount: Number(raw[2]),
      burstCount: Number(raw[3]),
      redisDown: false,
    };
  } catch {
    return {
      allowed: failOpen,
      deniedBy: '',
      dailyCount: -1,
      burstCount: -1,
      redisDown: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

function authedKey(
  tier: 'ai' | 'mut',
  procedure: string,
  userId: string,
  windowSec: number,
  nowMs: number,
): string {
  return `rl:${tier}:${procedure}:u:${userId}:${windowStart(nowMs, windowSec)}`;
}

function publicKey(procedure: string, cidr: string, windowSec: number, nowMs: number): string {
  return `rl:pub:${procedure}:ip:${cidr}:${windowStart(nowMs, windowSec)}`;
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

interface AiSpendOpts {
  /** Daily call budget. Rolls over on UTC day boundary. */
  readonly daily: number;
  /** Burst budget per 60s window inside the daily. Both must pass. */
  readonly burst: number;
}

export function aiSpendLimit(procedure: string, opts: AiSpendOpts) {
  return middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      // Should be unreachable — aiSpendLimit only chains after
      // protectedProcedure — but explicit guard keeps a bad refactor
      // honest.
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
    }
    const now = Date.now();
    const dailyKey = authedKey('ai', procedure, ctx.userId, DAILY_WINDOW_SEC, now);
    const burstKey = authedKey('ai', procedure, ctx.userId, BURST_WINDOW_SEC, now);
    const result = await checkAndIncrementCombined(
      ctx.redis,
      dailyKey,
      burstKey,
      opts.daily,
      opts.burst,
      /* failOpen */ false,
    );
    if (result.redisDown) {
      // AI-spend fails-CLOSED. A Redis outage 429s the call rather than
      // leak $1+ of AI spend during the window. Structured log so an
      // operator notices the outage.

      console.warn(
        JSON.stringify({
          event: 'rate_limit.redis_down',
          tier: 'ai',
          procedure,
          posture: 'fail-closed',
        }),
      );
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit unavailable. Try again shortly.',
      });
    }
    if (!result.allowed) {
      const which = result.deniedBy === 'burst' ? 'burst (3/min)' : 'daily';
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded (${which}).`,
      });
    }
    return next();
  });
}

interface MutationOpts {
  /** Per-minute call budget for the authed user. */
  readonly perMin: number;
  /**
   * Optional shared counter key — when two procedures share a budget
   * (matchmaking.enqueue + cancel; pushSubscriptions.register +
   * unregister), pass the same `sharedKey` to both middleware
   * invocations. The counter key uses `sharedKey` in place of the
   * tRPC procedure slug.
   */
  readonly sharedKey?: string;
}

export function mutationLimit(procedure: string, opts: MutationOpts) {
  const counterName = opts.sharedKey ?? procedure;
  return middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
    }
    const now = Date.now();
    const key = authedKey('mut', counterName, ctx.userId, MUTATION_WINDOW_SEC, now);
    const result = await checkAndIncrementSingle(
      ctx.redis,
      key,
      opts.perMin,
      MUTATION_WINDOW_SEC,
      /* failOpen */ true,
    );
    if (result.redisDown) {
      console.warn(
        JSON.stringify({
          event: 'rate_limit.redis_down',
          tier: 'mut',
          procedure: counterName,
          posture: 'fail-open',
        }),
      );
      return next();
    }
    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded.',
      });
    }
    return next();
  });
}

interface PublicOpts {
  readonly perMin: number;
}

export function publicLimit(procedure: string, opts: PublicOpts) {
  return middleware(async ({ ctx, next }) => {
    const now = Date.now();
    const key = publicKey(procedure, ctx.clientIpCidr, PUBLIC_WINDOW_SEC, now);
    const result = await checkAndIncrementSingle(
      ctx.redis,
      key,
      opts.perMin,
      PUBLIC_WINDOW_SEC,
      /* failOpen */ true,
    );
    if (result.redisDown) {
      console.warn(
        JSON.stringify({
          event: 'rate_limit.redis_down',
          tier: 'pub',
          procedure,
          posture: 'fail-open',
        }),
      );
      return next();
    }
    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded.',
      });
    }
    return next();
  });
}

// ---------------------------------------------------------------------------
// Fastify outer-hook helper — IP-keyed global ceiling above the tRPC tiers.
// Imported from server.ts. Lives here so the Lua + helpers stay in one
// file.
// ---------------------------------------------------------------------------

/**
 * Run the global-ceiling check for an arriving HTTP request. Returns
 * `{ allowed: true }` on success; `{ allowed: false, status: 429 }` on
 * deny. Redis-down → fail-OPEN (allowed=true) with a structured log;
 * Fastify outer hook is defense-in-depth above the tier middleware, not
 * the primary gate.
 *
 * `nowMs` parameter allows deterministic testing; production passes
 * `Date.now()`.
 */
const GLOBAL_PROCEDURE_NAME = '__global__';
const GLOBAL_WINDOW_SEC = 60;

export async function checkGlobalOuterHook(opts: {
  redis: RedisClient;
  ipCidr: string;
  perMin: number;
  nowMs?: number;
}): Promise<{ allowed: boolean; current: number; redisDown: boolean }> {
  const now = opts.nowMs ?? Date.now();
  const key = publicKey(GLOBAL_PROCEDURE_NAME, opts.ipCidr, GLOBAL_WINDOW_SEC, now);
  const result = await checkAndIncrementSingle(
    opts.redis,
    key,
    opts.perMin,
    GLOBAL_WINDOW_SEC,
    /* failOpen */ true,
  );
  if (result.redisDown) {
    console.warn(
      JSON.stringify({
        event: 'rate_limit.redis_down',
        tier: 'global',
        posture: 'fail-open',
      }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exposed for fixture tests
// ---------------------------------------------------------------------------

export const __internals = {
  SINGLE_GATE_LUA,
  COMBINED_ATOMIC_LUA,
  windowStart,
  authedKey,
  publicKey,
  DAILY_WINDOW_SEC,
  BURST_WINDOW_SEC,
  MUTATION_WINDOW_SEC,
  PUBLIC_WINDOW_SEC,
  GLOBAL_WINDOW_SEC,
  GLOBAL_PROCEDURE_NAME,
};
