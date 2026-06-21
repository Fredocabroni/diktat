// Internal-only surface for the M5 rate limiter. Production code MUST
// NOT import from this file — only `rate-limit.test.ts` and the dev
// probe (`scripts/probe-m5-rate-limit-runtime.ts`, gitignored) should.
// The `.internal.ts` naming convention signals intent; the
// `no-restricted-imports` rule in the repo's flat ESLint config now
// enforces it at the boundary (PR with the typed-cause + ESLint
// boundary hardening bundle; rule scope: `apps/api/src/**/*.ts`
// excluding the barrel + test/script carve-outs).
//
// PR #56 r2 security-reviewer L-internals: prevents the Lua scripts +
// key-builder functions from being trivially importable from the
// `rate-limit` module. The middleware factories remain the only
// public surface from `rate-limit.ts`.
//
// ---------------------------------------------------------------------------
// SHARD-MODE ASSUMPTION — load-bearing for COMBINED_ATOMIC_LUA atomicity.
// ---------------------------------------------------------------------------
//
// The Lua scripts below assume Upstash REST runs in SINGLE-SHARD mode
// (the current dev + prod posture). Under single-shard, EVAL runs on
// one Redis node and the GET / check / INCR / INCR sequence in
// `COMBINED_ATOMIC_LUA` is fully atomic — no concurrent caller can
// interleave between the daily/burst GETs and their corresponding
// INCRs.
//
// Under Upstash CLUSTER mode the two keys (`KEYS[1]` daily,
// `KEYS[2]` burst) may hash to DIFFERENT shards. EVAL across cross-
// shard keys is not atomic in cluster Redis — two concurrent callers
// could both pass the daily check and then both INCR, exceeding the
// daily budget by 1 per concurrent racer. The AI-spend ledger budget
// gate then under-counts and the per-task USD cap leaks proportional
// to concurrency.
//
// Cluster-mode migration path — pick ONE:
//   (a) Hash-tag the two keys so they land on the same shard. Rewrite
//       `authedKey('ai', ...)` to wrap the procedure slug in `{...}`
//       so Redis cluster sharding hashes only the bracketed portion.
//       Keys become `rl:ai:{<procedure>:<userId>}:<windowStart>` and
//       both daily + burst share the same hash slot. Lua semantics
//       unchanged; `COMBINED_ATOMIC_LUA` stays atomic.
//   (b) Replace `COMBINED_ATOMIC_LUA` with a Redis WATCH/MULTI/EXEC
//       optimistic-concurrency block in the TS caller. More round
//       trips per call (worse latency) but explicit serializability
//       semantics that don't depend on key co-location.
//   (c) Serialize to one Redis key with an embedded counter pair
//       (e.g. JSON `{d, b, dExpAt, bExpAt}` parsed in Lua). Single
//       key by definition, but loses fixed-window TTL ergonomics and
//       requires manual expiration accounting.
//
// (a) is the minimal-diff path and the default recommendation; (b)
// is the safest in heterogeneous deployments; (c) trades semantic
// clarity for absolute serializability. The choice should be made
// in the same PR that flips Upstash to cluster mode, with a
// regression test that asserts the daily counter stays accurate
// under concurrent load.
//
// PR #62 round-3 leftover #7 (COMBINED_ATOMIC_LUA single-shard
// atomicity assumption).

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
//
// ATOMICITY ASSUMES SINGLE-SHARD UPSTASH. See the file header for
// the cluster-mode migration paths — the GET / check / INCR / INCR
// sequence below is only atomic when `KEYS[1]` (daily) and `KEYS[2]`
// (burst) reside on the same Redis node. Cluster mode breaks this
// without a hash-tag rewrite of the key shape.
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

export const QUERY_WINDOW_SEC = 60;

export function authedKey(
  tier: 'ai' | 'mut' | 'q',
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
  QUERY_WINDOW_SEC,
  PUBLIC_WINDOW_SEC,
  GLOBAL_WINDOW_SEC,
  GLOBAL_PROCEDURE_NAME,
};
