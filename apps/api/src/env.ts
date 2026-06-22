// Zod-validated runtime env. Parse once at boot; fail loud on bad config.

import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  // Number of trusted reverse-proxy hops in front of this API. When set,
  // server.ts wires `trustProxy: <this number>` into the Fastify
  // constructor so `request.ip` resolves to the real client IP via the
  // `X-Forwarded-For` chain instead of the immediate TCP peer.
  //
  // UNSET in local dev (no proxy, request.ip = TCP peer = correct).
  // REQUIRED in production: server.ts asserts at boot and refuses to
  // start if NODE_ENV='production' but this is unset, because every
  // IP-keyed rate-limit counter would otherwise collapse to the proxy
  // IP and bypass the public-tier budgets. See the M5 trustProxy gate
  // in docs/TYRION_BUILD_QUEUE.md.
  //
  // Bounds (PR #78 round-1 security-reviewer MED + LOW#1):
  //   - `.min(1)`: NOT `.min(0)`. Fastify treats `trustProxy: 0` as
  //     `false` — it does not walk the X-Forwarded-For chain at all,
  //     so request.ip resolves back to the TCP peer (the proxy) and
  //     the boot gate silently fails to protect. The value 0 has no
  //     meaningful production use-case; if there is genuinely no
  //     proxy, leave this UNSET. The boot gate's undefined-check then
  //     fires correctly in production.
  //   - `.max(10)`: bounds the X-Forwarded-For walk depth. If the hop
  //     count is over-stated (e.g. 999), Fastify trusts more forwarder
  //     entries than actually exist, and a client can spoof their IP
  //     by injecting XFF entries before the real proxy entry. 10 is a
  //     generous ceiling for any plausible deployment topology
  //     (Railway = 1, +1 per CDN like Cloudflare).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  SUPABASE_JWT_ISSUER: z.string().url().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),

  // Upstash REST. The matchmaking router writes to the same
  // sorted-set and meta keys that the workers tick consumes.
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Comma-separated list of allowed CORS origins. Default is local dev only.
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid env:\n${formatted}`);
  }
  return parsed.data;
}
