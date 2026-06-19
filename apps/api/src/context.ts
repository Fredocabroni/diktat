// tRPC request context. Runs on every request. Inexpensive: one HS256
// JWT verify (microseconds), one Supabase client construction (object
// literal, no I/O). Service-role client is constructed lazily — only
// routers that opt in see it.

import { verifyJwt } from '@diktat/auth';
import { Redis } from '@upstash/redis';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Env } from './env.js';
import { userScopedClient, type DbClient } from './supabase.js';

// JWT `sub` claim — must be a UUID. Supabase mints `sub = auth.users.id`
// which is always uuid v4. Validating here closes a key-corruption
// vector: a crafted JWT with `sub = "x:extra:field"` would otherwise
// produce malformed Redis keys like `rl:mut:battles.submitAnswer:u:x:
// extra:field:12345`. PR #56 r2 security-reviewer MEDIUM-sub-validation.
const subjectSchema = z.string().uuid();

/**
 * Minimal Redis surface the routers depend on. Lets tests substitute
 * a fake without pulling the real Upstash client.
 */
export interface RedisClient {
  zadd(key: string, score_member: { score: number; member: string }): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zscore(key: string, member: string): Promise<number | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  get(key: string): Promise<unknown | null>;
  del(...keys: string[]): Promise<number>;
  // M5 rate limiter — runs the fixed-window check+increment Lua via the
  // Upstash REST `eval` endpoint. KEYS / ARGV are positional; Upstash
  // returns whatever the Lua script returns, typed as `unknown` so the
  // caller narrows.
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

export interface Context {
  readonly env: Env;
  readonly userId: string | null;
  readonly role: string;
  readonly db: DbClient;
  readonly bearerToken: string | null;
  readonly redis: RedisClient;
  // Client IP normalized to a CIDR group (/24 IPv4, /64 IPv6). Used by
  // `publicLimit` middleware to key rate-limit counters for anonymous
  // / un-bearered tRPC procedures. See `rate-limit.ts` for the
  // extraction + topology constraint documented at buildContext.
  readonly clientIpCidr: string;
}

let cachedRedis: Redis | null = null;
// Exported so server.ts can reuse the same client for its Fastify outer
// hook instead of constructing a second instance (PR #56 r1 security-
// reviewer L-redis-dup).
export function getOrBuildRedis(env: Env): Redis {
  if (cachedRedis !== null) return cachedRedis;
  cachedRedis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return cachedRedis;
}

function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Normalize a client IP to a CIDR group: /24 for IPv4, /64 for IPv6.
 * Single-IP keying would lock every user behind a CGNAT or university
 * NAT to the same rate-limit bucket; CIDR keying is the standard
 * NAT-block shape.
 *
 * TOPOLOGY CONSTRAINT — load-bearing for IP-keyed rate limiting:
 *
 * Fastify's `request.ip` returns the trusted client IP IF `trustProxy`
 * is configured on the Fastify constructor. Without `trustProxy`, it
 * returns the immediate TCP peer (the reverse proxy / load balancer),
 * NOT the actual client IP. Every IP-keyed counter would then aggregate
 * to a single proxy IP and the rate limit would become a global cap.
 *
 * Today (`apps/api/src/server.ts:11`) the Fastify constructor has NO
 * `trustProxy` option — appropriate for local dev where there is no
 * proxy. The api is not yet on a public DNS (`deploy-railway.yml` is a
 * no-op stub gated on `ENABLE_RAILWAY_DEPLOY`), so the constraint is
 * dormant. Queued as a Phase-4 follow-up item that MUST land in the
 * same commit as the Railway deploy activation: set `trustProxy: 1`
 * (or the exact known-proxy hop count for the deployment topology).
 * See queue entry "M5 trust-proxy config — must land with Railway".
 *
 * IPv6 handling: Upstash sometimes returns Fastify a synthetic
 * v4-mapped v6 like `::ffff:192.0.2.1`. Strip the prefix so the v4
 * /24 grouping applies; otherwise the CIDR algebra below produces a
 * v6 /64 that pools entire IPv6 address-allocation blocks (way too
 * loose).
 */
export function normalizeIpToCidr(rawIp: string): string {
  if (!rawIp) return 'ip-unknown';
  // Strip IPv4-mapped IPv6 prefix.
  const ip = rawIp.startsWith('::ffff:') ? rawIp.slice('::ffff:'.length) : rawIp;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    // Each octet must be a 1–3 digit string AND in the 0–255 range.
    // The regex alone passes `999.999.999.999`; the numeric check
    // closes that hole. (PR #56 r1 security-reviewer L-octet-range.)
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return 'ip-malformed-v4';
  }
  if (ip.includes(':')) {
    // IPv6 /64. EXPAND `::` compression to full 8-hextet form FIRST,
    // then take the first 4 hextets as the /64 prefix.
    //
    // Naive `split(':').slice(0, 4)` is broken: for `2001:db8::1` it
    // yields `['2001','db8','','1']` and pretends `1` is the 4th
    // hextet, but `1` is the LAST hextet (group 8). The real /64 is
    // `2001:db8::/64`. This is load-bearing for mobile PWA traffic —
    // cellular is overwhelmingly IPv6 — and a wrong /64 either pools
    // unrelated users into one rate-limit bucket or lets a client
    // dodge the limit by varying its compressed form.
    const expanded = expandIPv6(ip);
    if (!expanded) return 'ip-malformed-v6';
    const cleaned = expanded.slice(0, 4).map((p) => (p === '0' ? '0' : p));
    return `${cleaned.join(':')}::/64`;
  }
  return 'ip-unparseable';
}

/**
 * Expand `::` compression in an IPv6 string to the full 8-hextet form.
 * Returns null on malformed input. Empty hextets are returned as the
 * string `'0'`; leading-zero collapsing inside a hextet is preserved
 * as the original token.
 *
 * Cases:
 *   `::`              → ['0','0','0','0','0','0','0','0']
 *   `::1`             → ['0','0','0','0','0','0','0','1']
 *   `1::`             → ['1','0','0','0','0','0','0','0']
 *   `2001:db8::1`     → ['2001','db8','0','0','0','0','0','1']
 *   `fe80::1:2:3:4`   → ['fe80','0','0','0','1','2','3','4']
 */
// Each hextet must be 1–4 hex digits. Otherwise the function returns
// null and normalizeIpToCidr classifies as 'ip-malformed-v6'. Without
// this guard a value like `::ZZZZ:1` would pass the structural check
// and produce a key like `rl:pub:auth.session:ip:0:0:0:0:ZZZZ:1::/64`.
// PR #56 r2 security-reviewer L-hextet-validation.
const HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

function expandIPv6(ip: string): string[] | null {
  const dcIndex = ip.indexOf('::');
  let expanded: string[];
  if (dcIndex === -1) {
    const parts = ip.split(':');
    if (parts.length !== 8) return null;
    expanded = parts;
  } else {
    // Split on `::` into head and tail. Each half is `:`-separated;
    // empty strings (from leading or trailing `::`) are filtered.
    const head = ip
      .slice(0, dcIndex)
      .split(':')
      .filter((p) => p !== '');
    const tail = ip
      .slice(dcIndex + 2)
      .split(':')
      .filter((p) => p !== '');
    const gap = 8 - head.length - tail.length;
    if (gap < 0) return null; // already 8 hextets — `::` is redundant/illegal
    expanded = [...head, ...Array.from({ length: gap }, () => '0'), ...tail];
  }
  // Validate every hextet. The Array.fill('0') gaps satisfy the regex.
  for (const h of expanded) {
    if (!HEXTET_RE.test(h)) return null;
  }
  return expanded;
}

export async function buildContext(env: Env, req: FastifyRequest): Promise<Context> {
  const rawBearer = extractBearer(req.headers.authorization);

  let userId: string | null = null;
  let role = 'anon';
  let verifiedToken: string | null = null;

  if (rawBearer) {
    try {
      const claims = await verifyJwt(rawBearer, {
        // Prefer JWKS (asymmetric ES256/RS256) when configured. Fall back
        // to legacy HS256 shared-secret verification.
        ...(env.SUPABASE_JWKS_URL
          ? { jwksUrl: env.SUPABASE_JWKS_URL }
          : { secret: env.SUPABASE_JWT_SECRET }),
        ...(env.SUPABASE_JWT_ISSUER ? { issuer: env.SUPABASE_JWT_ISSUER } : {}),
      });
      // Parse rather than assume — see subjectSchema header. A throw
      // here cascades to the catch below and the request is treated
      // as anon, which is the correct posture (a malformed sub means
      // the JWT verifier returned something we can't safely embed).
      userId = subjectSchema.parse(claims.sub);
      role = claims.role;
      verifiedToken = rawBearer;
    } catch {
      // Invalid JWT → treat as anon. Individual routers decide whether to
      // 401 via `protectedProcedure`; we do not throw here so public
      // procedures remain callable with a malformed Authorization header.
      userId = null;
      role = 'anon';
      verifiedToken = null;
    }
  }

  // Only forward verified tokens to PostgREST. Forwarding a bad token would
  // trigger a 401 from Supabase for every downstream query, silently breaking
  // public procedures that do a DB read with a stale client token.
  const db = userScopedClient(env, verifiedToken);

  return {
    env,
    userId,
    role,
    db,
    bearerToken: verifiedToken,
    redis: getOrBuildRedis(env),
    clientIpCidr: normalizeIpToCidr(req.ip ?? ''),
  };
}
