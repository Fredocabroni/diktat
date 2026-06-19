// Internal-only surface for the M5 rate limiter. Production code MUST
// NOT import from this file — only `rate-limit.test.ts` and the dev
// probe (`scripts/probe-m5-rate-limit-runtime.ts`, gitignored) should.
// The `.internal.ts` naming convention signals intent; a future lint
// rule can enforce it at the boundary.
//
// PR #56 r2 security-reviewer L-internals: prevents the Lua scripts +
// key-builder functions from being trivially importable from the
// `rate-limit` module. The middleware factories remain the only
// public surface from `rate-limit.ts`.

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

// Single-gate fixed-window: INCR-then-check semantics in the CALLER
// (Lua only does the atomic INCR+EXPIRE). The TS layer compares the
// returned counter to the limit. Denied calls increment the counter.
//
// Returns [cur, ttlSec] so the TS layer can stamp an accurate
// Retry-After header on deny.
export const SINGLE_GATE_LUA = `
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {cur, ttl}
`.trim();

// Combined-atomic two-gate fixed-window: check-then-INCR semantics
// across BOTH counters. Returns {allowed, deniedBy, dailyCount,
// burstCount, ttlSec} — ttl is the remaining seconds on the DENYING
// key (the one that caused the deny), or -1 on the allowed path. The
// caller stamps Retry-After from ttlSec.
//
// EXPIRE-only-on-first-INCR is intentional fixed-window: each new
// windowStart minted by the TS caller is a new key. Refreshing TTL
// on later INCRs would defeat rollover.
export const COMBINED_ATOMIC_LUA = `
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
local b = tonumber(redis.call('GET', KEYS[2]) or '0')
local d_limit = tonumber(ARGV[1])
local b_limit = tonumber(ARGV[3])
if d >= d_limit then
  local ttl = redis.call('TTL', KEYS[1])
  return {0, 'daily', d, b, ttl}
end
if b >= b_limit then
  local ttl = redis.call('TTL', KEYS[2])
  return {0, 'burst', d, b, ttl}
end
d = redis.call('INCR', KEYS[1])
if d == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
b = redis.call('INCR', KEYS[2])
if b == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
return {1, '', d, b, -1}
`.trim();

// ---------------------------------------------------------------------------
// Window sizes (all in seconds)
// ---------------------------------------------------------------------------

export const DAILY_WINDOW_SEC = 86_400;
export const BURST_WINDOW_SEC = 60;
export const MUTATION_WINDOW_SEC = 60;
export const PUBLIC_WINDOW_SEC = 60;
export const GLOBAL_WINDOW_SEC = 60;
export const GLOBAL_PROCEDURE_NAME = '__global__';

// ---------------------------------------------------------------------------
// Window-start + key builders
// ---------------------------------------------------------------------------

const MS_PER_SEC = 1_000;

export function windowStart(nowMs: number, windowSec: number): number {
  return Math.floor(nowMs / (windowSec * MS_PER_SEC));
}

export function authedKey(
  tier: 'ai' | 'mut',
  procedure: string,
  userId: string,
  windowSec: number,
  nowMs: number,
): string {
  return `rl:${tier}:${procedure}:u:${userId}:${windowStart(nowMs, windowSec)}`;
}

export function publicKey(
  procedure: string,
  cidr: string,
  windowSec: number,
  nowMs: number,
): string {
  return `rl:pub:${procedure}:ip:${cidr}:${windowStart(nowMs, windowSec)}`;
}

// ---------------------------------------------------------------------------
// Aggregated test-fixture surface (mirrors the old `__internals` shape).
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
