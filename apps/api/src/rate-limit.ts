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
//   - The SINGLE-gate factories (mutationLimit, queryLimit, publicLimit)
//     use INCR-then-check. The atomic INCR fires BEFORE the limit
//     check, so a denied call INCREMENTS the counter (cur lands at
//     limit+1). Practical impact: a user who hits 31/min on
//     battles.submitAnswer sees the next call 429. The 32nd attempt
//     would also see 429 and push the counter to 33. Counter resets
//     when the window expires. This is by-design — the alternative
//     (atomic check-then-INCR via Lua) costs one extra Lua round-trip
//     for the simple case and buys nothing operationally for general
//     mutations OR for polling reads. PR #62 round-1 security-reviewer
//     MEDIUM-1 confirmed: no practical bypass, only cosmetic
//     over-counting on a blocked client for the window duration.
//   - The COMBINED-atomic factory (aiSpendLimit) uses check-then-INCR
//     across BOTH counters atomically inside Lua. A denied call does
//     NOT increment EITHER counter — necessary because the daily
//     window is 86400s; allowing the 21st call (deny) to push the
//     daily counter to 21 would mean the user is now over-counted for
//     the rest of the day even if their next attempt is days later
//     after the counter was supposed to roll over.

import { TRPCError } from '@trpc/server';

import type { RedisClient } from './context.js';
// Implementation details (Lua scripts, key builders, window sizes) live
// in `rate-limit.internal.ts`. Production code MUST NOT import from
// `.internal.ts` — only the middleware factories defined below should.
// PR #56 r2 security-reviewer L-internals.
import {
  authedKey,
  BURST_WINDOW_SEC,
  COMBINED_ATOMIC_LUA,
  DAILY_WINDOW_SEC,
  GLOBAL_PROCEDURE_NAME,
  GLOBAL_WINDOW_SEC,
  MUTATION_WINDOW_SEC,
  publicKey,
  PUBLIC_WINDOW_SEC,
  QUERY_WINDOW_SEC,
  SINGLE_GATE_LUA,
} from './rate-limit.internal.js';
import { middleware } from './trpc.js';

// Lua scripts, key builders, window sizes are imported above from
// `rate-limit.internal.ts` (see header). Everything below operates on
// those imports.

// (Lua scripts, window sizes, and key builders all live in
// `rate-limit.internal.ts` — see the import block at the top of this
// file. This module composes them into the public middleware factories.)

// ---------------------------------------------------------------------------
// Shared checkAndIncrement helpers — exported for the Fastify outer hook
// in server.ts to reuse without going through tRPC.
// ---------------------------------------------------------------------------

export interface SingleGateResult {
  readonly allowed: boolean;
  readonly current: number;
  /** Seconds until the window key expires. Used for Retry-After. */
  readonly retryAfterSec: number;
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
    // SINGLE_GATE_LUA returns [cur, ttl]. Accept legacy single-number
    // returns as well (cur only, ttl = window) so a half-deployed
    // helper doesn't crash — bounded by Number.isFinite below.
    let current: number;
    let ttlSec: number;
    if (Array.isArray(raw) && raw.length >= 2) {
      current = Number(raw[0]);
      ttlSec = Number(raw[1]);
    } else {
      current = typeof raw === 'number' ? raw : Number(raw);
      ttlSec = windowSec;
    }
    if (!Number.isFinite(current)) {
      // Bad return — treat as Redis-down and use failOpen policy.
      return { allowed: failOpen, current: -1, retryAfterSec: windowSec, redisDown: true };
    }
    // TTL <= 0 fall-back: -1 means no TTL set, -2 means key missing.
    // Either should not happen post-INCR+EXPIRE, but if it does,
    // advise clients to wait one window length.
    const retryAfterSec = ttlSec > 0 ? Math.ceil(ttlSec) : windowSec;
    return { allowed: current <= limit, current, retryAfterSec, redisDown: false };
  } catch {
    // Upstash REST timeout / network / parse error.
    return { allowed: failOpen, current: -1, retryAfterSec: windowSec, redisDown: true };
  }
}

export interface CombinedGateResult {
  readonly allowed: boolean;
  readonly deniedBy: 'daily' | 'burst' | '';
  readonly dailyCount: number;
  readonly burstCount: number;
  /**
   * Seconds until the denying key expires. -1 on allowed path. Used
   * for an accurate Retry-After header — a daily deny carries up to
   * 86400s; a burst deny carries up to 60s.
   */
  readonly retryAfterSec: number;
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
    )) as [number | string, string, number | string, number | string, number | string];
    // COMBINED_ATOMIC_LUA returns 5-tuple [allowed, deniedBy, d, b, ttl].
    if (!Array.isArray(raw) || raw.length < 4) {
      return {
        allowed: failOpen,
        deniedBy: '',
        dailyCount: -1,
        burstCount: -1,
        retryAfterSec: BURST_WINDOW_SEC,
        redisDown: true,
      };
    }
    const allowedRaw = Number(raw[0]);
    const allowed = allowedRaw === 1;
    const deniedBy =
      (raw[1] as string) === 'daily' || (raw[1] as string) === 'burst'
        ? (raw[1] as 'daily' | 'burst')
        : '';
    const ttlRaw = raw.length >= 5 ? Number(raw[4]) : -1;
    // Allowed path: TTL is meaningless; ignore. Deny path: TTL <= 0
    // shouldn't happen (key just GET'd successfully), but fall back to
    // the window length of the denying gate.
    let retryAfterSec: number;
    if (allowed) {
      retryAfterSec = -1;
    } else if (ttlRaw > 0) {
      retryAfterSec = Math.ceil(ttlRaw);
    } else {
      retryAfterSec = deniedBy === 'daily' ? DAILY_WINDOW_SEC : BURST_WINDOW_SEC;
    }
    return {
      allowed,
      deniedBy,
      dailyCount: Number(raw[2]),
      burstCount: Number(raw[3]),
      retryAfterSec,
      redisDown: false,
    };
  } catch {
    return {
      allowed: failOpen,
      deniedBy: '',
      dailyCount: -1,
      burstCount: -1,
      retryAfterSec: BURST_WINDOW_SEC,
      redisDown: true,
    };
  }
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
        cause: { retryAfterSec: BURST_WINDOW_SEC } as unknown as Error,
      });
    }
    if (!result.allowed) {
      // Wire message redacts the numeric cap — server-side log gets
      // the full classification. Disclosing "(burst (3/min))" lets an
      // adversary calibrate just under the cap. PR #56 r2 reviewer
      // MEDIUM-redaction.
      const which = result.deniedBy === 'burst' ? 'burst' : 'daily';

      console.warn(
        JSON.stringify({
          event: 'rate_limit.deny',
          tier: 'ai',
          procedure,
          deniedBy: result.deniedBy,
          dailyCount: result.dailyCount,
          burstCount: result.burstCount,
          retryAfterSec: result.retryAfterSec,
        }),
      );
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded (${which}).`,
        // Carries retryAfterSec through to responseMeta in server.ts
        // so the Retry-After header reflects the ACTUAL window of the
        // denying gate — 86400s for daily, 60s for burst.
        cause: { retryAfterSec: result.retryAfterSec } as unknown as Error,
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
        cause: { retryAfterSec: result.retryAfterSec } as unknown as Error,
      });
    }
    return next();
  });
}

// Static map of query procedure → server-side DB fan-out count.
// Used to enrich the redis_down warn log (M-2(a)) so an Upstash
// outage that re-opens the high-fan-out read path is queryable in
// logs. `poolRisk` is derived from fanOut: anything ≥ 4 queries is
// 'high' because it's the class of read that exhausts the Supabase
// pool first under uncapped load (debates.getBattle, the round-3
// reviewer's specific concern). Values pulled from the recon (PR #62
// summary table); update when a procedure's server implementation
// changes. PR #62 round-1 security-reviewer MEDIUM-2(a).
const QUERY_FAN_OUT: Record<string, number> = {
  'battles.getRound': 1,
  'battles.getBattle': 3,
  'debates.getBattle': 5,
  'matchmaking.getStatus': 0, // pure Redis — no DB queries
  'user.me': 3, // 1 RPC sequential + 2 parallel
  'feed.list': 1,
  'factCheck.getVerdict': 1, // defensive default; no client caller today
  'pushSubscriptions.listMine': 1, // defensive default; no client caller today
};

function classifyPoolRisk(fanOut: number): 'low' | 'medium' | 'high' {
  if (fanOut >= 4) return 'high';
  if (fanOut >= 2) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// queryLimit — read-tier middleware. Sibling to mutationLimit:
//   - keys on ctx.userId (authed reads only — anon queries gated upstream
//     by protectedProcedure where it applies)
//   - fail-OPEN on Redis outage (matches mutation tier — a brief Upstash
//     blip should not 429 polling reads and brick the live battle UI)
//   - reuses SINGLE_GATE_LUA via checkAndIncrementSingle, so TTL-based
//     Retry-After is threaded through `cause` for the responseMeta header
//   - SEPARATE NAMESPACE: tier label 'q' — counter shape is
//     `rl:q:{procedure}:u:{userId}:{windowStart}`. A user hammering
//     battles.getRound at 180/min does NOT eat into their mutation budget
//     for battles.submitAnswer or any other procedure.
// Closes the M5.1 polling-query gap: round-3 reviewer flagged
// debates.getBattle (5-query fan-out at 0.5Hz) and battles.getRound
// (1Hz) as exhausting the DB pool before the IP-keyed outer hook fires.
// ---------------------------------------------------------------------------
interface QueryOpts {
  /** Per-minute call budget for the authed user on this query procedure. */
  readonly perMin: number;
}

export function queryLimit(procedure: string, opts: QueryOpts) {
  return middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
    }
    const now = Date.now();
    const key = authedKey('q', procedure, ctx.userId, QUERY_WINDOW_SEC, now);
    const result = await checkAndIncrementSingle(
      ctx.redis,
      key,
      opts.perMin,
      QUERY_WINDOW_SEC,
      /* failOpen */ true,
    );
    if (result.redisDown) {
      // M-2(a): structured Upstash-outage warn enriched with fanOut +
      // poolRisk so an outage that re-opens the high-fan-out read path
      // (debates.getBattle 5q, battles.getBattle / user.me 3q) is
      // queryable in logs. ADDITIVE — control flow is unchanged: we
      // still `return next()` and the request proceeds. The log is the
      // signal an operator queries during an outage to see exactly
      // which query procedures are running uncapped. Round-3 follow-up
      // (queued, not in scope here) is whether the high-risk
      // procedures should fail-CLOSED instead.
      const fanOut = QUERY_FAN_OUT[procedure] ?? 1;
      console.warn(
        JSON.stringify({
          event: 'rate_limit.redis_down',
          tier: 'q',
          procedure,
          posture: 'fail-open',
          fanOut,
          poolRisk: classifyPoolRisk(fanOut),
        }),
      );
      return next();
    }
    if (!result.allowed) {
      // LOW-1: structured deny log mirroring `aiSpendLimit`'s pattern
      // so per-procedure deny frequency is observable in production.
      // The wire message stays the redacted "Rate limit exceeded."
      // (no budget value disclosed); the numeric `current` + the
      // `retryAfterSec` land server-side only.
      console.warn(
        JSON.stringify({
          event: 'rate_limit.deny',
          tier: 'q',
          procedure,
          current: result.current,
          retryAfterSec: result.retryAfterSec,
        }),
      );
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded.',
        cause: { retryAfterSec: result.retryAfterSec } as unknown as Error,
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
        cause: { retryAfterSec: result.retryAfterSec } as unknown as Error,
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
export async function checkGlobalOuterHook(opts: {
  redis: RedisClient;
  ipCidr: string;
  perMin: number;
  nowMs?: number;
}): Promise<SingleGateResult> {
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

// The previous `export const __internals = {...}` lived here. It moved
// to `rate-limit.internal.ts` to keep the Lua scripts and key builders
// out of `rate-limit.ts`'s public surface (PR #56 r2 security-reviewer
// L-internals). Test files import the fixture surface from
// `rate-limit.internal.ts` directly.
