import cors from '@fastify/cors';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';

import { buildContext, getOrBuildRedis, normalizeIpToCidr, type RedisClient } from './context.js';
import { loadEnv } from './env.js';
import { buildOuterHookBlockedBody, OUTER_HOOK_WINDOW_SEC } from './outer-hook.js';
import { checkGlobalOuterHook, extractRetryAfterSec } from './rate-limit.js';
import { appRouter, type AppRouter } from './routers/index.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Activation-safety: any non-dev/test environment must declare its
// trusted-proxy hop count.
//
// Fastify's `request.ip` returns the immediate TCP peer when `trustProxy`
// is unset. In local dev that's correct (no proxy in front). Behind
// Railway / Vercel / Cloudflare / any other reverse proxy the immediate
// peer is the edge proxy, NOT the real client; every IP-keyed rate-limit
// counter then collapses to a single proxy IP and the public-tier
// budgets are effectively bypassed (M5 trustProxy gate, docs/TYRION_BUILD_QUEUE.md).
//
// The hard gate: if NODE_ENV is anything OTHER than 'development' or
// 'test' (so production today, AND any future staging/preview value if
// the Zod enum is later widened) and TRUSTED_PROXY_HOPS is unset, refuse
// to boot. A misconfigured deploy crashes loud at startup instead of
// silently collapsing rate limiting.
//
// Exclusion list, NOT `=== 'production'` — PR #78 round-2 security-reviewer
// MED #1. The earlier `=== 'production'` shape was fragile: today's Zod
// enum (`development | test | production`) rejects e.g. `'staging'` at
// parse-time so the gate was functionally safe, but if anyone ever
// widens the enum to add `'staging'` / `'preview'` (a common Railway
// pattern), the gate would silently fail open on those values with no
// compiler signal. Inverting to an exclusion list makes the production-
// safe path the default and the local-dev path the explicit exception
// — the gate now fails CLOSED on unknown environments rather than
// failing open.
//
// Design corrigendum (recon): the original queue-entry assertion
// (`throw if env.ENABLE_RAILWAY_DEPLOY === 'true' && !trustProxy`)
// could not work — `ENABLE_RAILWAY_DEPLOY` is a GHA repository variable,
// never in process.env at API runtime, so the check would read
// `undefined` and always pass. `TRUSTED_PROXY_HOPS` is a real runtime
// env var (set on the Railway service) and therefore actually observable
// here.
// ---------------------------------------------------------------------------
if (
  env.NODE_ENV !== 'development' &&
  env.NODE_ENV !== 'test' &&
  env.TRUSTED_PROXY_HOPS === undefined
) {
  // Use console.error rather than app.log because Fastify isn't constructed
  // yet; we exit before any logger is wired.

  console.error(
    JSON.stringify({
      event: 'boot.activation_safety_failed',
      reason: 'TRUSTED_PROXY_HOPS_unset_in_non_dev_test_env',
      nodeEnv: env.NODE_ENV,
      message:
        `Refusing to start: NODE_ENV='${env.NODE_ENV}' is not a local dev/test environment ` +
        'and requires TRUSTED_PROXY_HOPS to be set. Without trustProxy, every IP-keyed ' +
        'rate-limit counter collapses to the proxy IP and the public-tier budgets are ' +
        'bypassed. Set TRUSTED_PROXY_HOPS to the reverse-proxy chain depth (Railway edge ' +
        '= 1, +1 per CDN). See the M5 trustProxy gate in docs/TYRION_BUILD_QUEUE.md.',
    }),
  );
  process.exit(1);
}

// Reuse the same Upstash client the per-request tRPC contexts use. The
// prior shape constructed a separate `new Redis({...})` here, doubling
// the credential surface in memory for no functional gain (Upstash REST
// is stateless). PR #56 r1 security-reviewer L-redis-dup.
const outerRedis = getOrBuildRedis(env) as unknown as RedisClient;

// Outer-hook global ceiling. M5 design's anti-DDoS floor; tuned to a
// generous human-burst per /24 NAT block. Tighten in M6 if real abuse
// shows up post-launch.
const OUTER_HOOK_PER_MIN = 1_200;
// OUTER_HOOK_WINDOW_SEC moved to ./outer-hook.ts so the body builder
// derives `window: '${N}s'` from the same single source of truth that
// `responseMeta`'s Retry-After fallback below uses. PR #67 round-1
// reviewer LOW-4. One-way import: server.ts → outer-hook.ts; no cycle.

// Paths exempt from the outer hook. Container / k8s / Railway health
// checks fire often and would otherwise consume the IP-keyed budget.
// `/health` is the only currently-served non-/trpc path.
const OUTER_HOOK_EXEMPT_PATHS = new Set<string>(['/health']);

const app = Fastify({
  logger: {
    // Never let bearer tokens, cookies, or Supabase error internals land in
    // structured logs. PostgREST errors carry SQL hints + occasionally row
    // data; keep them out of the default transport.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'err.cause.details',
        'err.cause.hint',
        'err.cause.message',
      ],
      remove: true,
    },
  },
  maxParamLength: 5_000,
  // Conditional trustProxy: when TRUSTED_PROXY_HOPS is set, Fastify
  // consults the `X-Forwarded-For` chain (right-to-left, N hops in) when
  // building `request.ip`. When unset (local dev), trustProxy stays off
  // and `request.ip` is the immediate TCP peer — the byte-identical
  // pre-bundle shape. The production-must-be-set check fires above; here
  // we just wire the value when it's been declared.
  ...(env.TRUSTED_PROXY_HOPS !== undefined ? { trustProxy: env.TRUSTED_PROXY_HOPS } : {}),
});

// Echo the resolved listen target + trustProxy posture at boot. The
// `request.ip` recovery check the queue describes (curl /health, read
// the boot log, verify the public client IP shows up) reads this line.
app.log.info(
  {
    event: 'boot.started',
    host: env.HOST,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    trustProxyHops: env.TRUSTED_PROXY_HOPS ?? null,
  },
  'diktat-api booting',
);

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, env.WEB_ORIGINS.includes(origin));
  },
  // Bearer-auth only; no cookies on this API surface. Leaving credentials off
  // narrows the blast radius if a future origin is allow-listed by mistake.
  credentials: false,
});

// Outer-hook global IP-keyed ceiling. Runs BEFORE the tRPC plugin's
// route handlers. Exempts `/health` (declared in
// `OUTER_HOOK_EXEMPT_PATHS`) so probe traffic doesn't consume budget.
//
// On a Redis outage this fails-OPEN with a structured log — the outer
// hook is defense-in-depth above the per-procedure middleware, not the
// primary gate. The per-procedure tiers handle their own posture.
//
// Body bytes are not parsed yet at this hook layer; Fastify guarantees
// `request.ip` is populated. `trustProxy` is set conditionally above from
// `env.TRUSTED_PROXY_HOPS`: unset in local dev (request.ip = TCP peer)
// and required in production (asserted at boot). Behind Railway/Vercel
// with TRUSTED_PROXY_HOPS wired, `request.ip` resolves to the real
// client via the X-Forwarded-For chain. See context.ts:normalizeIpToCidr
// for the IP-to-CIDR normalization the keys then use.
app.addHook('onRequest', async (request, reply) => {
  // Exact-match exemption ONLY. The prior `startsWith('/health?')`
  // would have exempted paths like `/health/../../etc` too. Fastify's
  // router would 404 those, but the exemption is consumed regardless,
  // which is the wrong posture. PR #56 r2 security-reviewer L-health-exempt.
  if (OUTER_HOOK_EXEMPT_PATHS.has(request.url)) {
    return;
  }
  // Also exempt `/health` with a query string (e.g. `/health?probe=1`).
  // Strip the query before the set check so probes that decorate the
  // URL aren't rate-limited but `/healthFAKE?...` isn't matched.
  const pathOnly = request.url.split('?', 1)[0]!;
  if (OUTER_HOOK_EXEMPT_PATHS.has(pathOnly)) {
    return;
  }
  const ipCidr = normalizeIpToCidr(request.ip ?? '');
  request.log.info(
    { event: 'outer_hook.resolved_ip', ip: request.ip, cidr: ipCidr, path: pathOnly },
    'outer-hook resolved client IP',
  );
  const result = await checkGlobalOuterHook({
    redis: outerRedis,
    ipCidr,
    perMin: OUTER_HOOK_PER_MIN,
  });
  if (!result.allowed) {
    // RETURN the reply: with no return, an async onRequest hook can
    // fall through to the route handler after invoking `.send(...)`,
    // which then attempts a second `.send` and Fastify throws
    // FST_ERR_REP_ALREADY_SENT. Returning the reply object
    // short-circuits the request lifecycle deterministically.
    // RFC 6585 §4: 429 SHOULD include Retry-After. Use the TTL from
    // the checkGlobalOuterHook result (now threaded through the
    // single-gate helper) — accurate to the second instead of the
    // round window value.
    // Body shape lives in `outer-hook.ts` so it's unit-testable without
    // booting the Fastify app. The `limit` field was deliberately
    // dropped — it disclosed the numeric ceiling (1200/min) and let an
    // adversary calibrate just under it. RFC 6585 §4: Retry-After is
    // sufficient; the limit value adds no signal a legitimate client
    // needs. PR #65 round-3 reviewer MEDIUM-3.
    return reply
      .code(429)
      .header('Retry-After', String(result.retryAfterSec))
      .send(buildOuterHookBlockedBody());
  }
});

app.get('/health', async () => ({ status: 'ok', service: 'diktat-api' }));

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => buildContext(env, req),
    // RFC 6585 §4 Retry-After on 429 responses thrown by the
    // rate-limit middleware. `responseMeta` runs after the procedure
    // (success or thrown error) and can stamp headers + the HTTP
    // status. We add Retry-After only when any error is a
    // TOO_MANY_REQUESTS — every other error keeps default behavior.
    responseMeta({ errors }) {
      // Find any TOO_MANY_REQUESTS error and read its retryAfterSec
      // from `cause`. The rate-limit middleware in `rate-limit.ts`
      // threads the denying gate's TTL through a typed `RateLimitCause`
      // so this header is accurate for both 60s windows AND the daily
      // 86400s window. `extractRetryAfterSec` does the instanceof check
      // at the consumer site — typed both ends, zero casts. Fallback
      // is OUTER_HOOK_WINDOW_SEC when the cause is absent, of the wrong
      // type, or carries a non-positive retryAfterSec.
      for (const err of errors) {
        if (err.code !== 'TOO_MANY_REQUESTS') continue;
        const retryAfter = extractRetryAfterSec(err.cause, OUTER_HOOK_WINDOW_SEC);
        return { headers: new Headers({ 'retry-after': String(retryAfter) }) };
      }
      return {};
    },
    onError({ error, path }) {
      // Log only the shape we control. `error.cause` holds raw Supabase
      // errors that we never want echoed into structured logs.
      app.log.error({ code: error.code, path, message: error.message }, 'tRPC error');
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

app.listen({ port: env.PORT, host: env.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
