import { makeAlerter } from '@diktat/shared/alerts';
import { resolveDeploySha } from '@diktat/shared/deploy-sha';
import cors from '@fastify/cors';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';

import { checkJwtIssuer } from './activation-safety.js';
import { buildContext, getOrBuildRedis, normalizeIpToCidr, type RedisClient } from './context.js';
import { decideCorsOrigin } from './cors-origin.js';
import { loadEnv } from './env.js';
import { buildOuterHookBlockedBody, OUTER_HOOK_WINDOW_SEC } from './outer-hook.js';
import {
  checkAuthSessionHook,
  checkGlobalOuterHook,
  checkMutationBurstHook,
  extractRetryAfterSec,
} from './rate-limit.js';
import { appRouter, type AppRouter } from './routers/index.js';
import { checkWebOrigins } from './web-origins-gate.js';

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

// Second activation-safety gate (#170): WEB_ORIGINS must declare at
// least one non-localhost origin in non-dev/test. Factored into
// ./web-origins-gate.ts so the predicate is unit-testable without
// booting Fastify. Same exclusion-list posture as TRUSTED_PROXY_HOPS
// above — fails CLOSED on unknown NODE_ENV values.
const webOriginsFailure = checkWebOrigins(env);
if (webOriginsFailure) {
  console.error(
    JSON.stringify({
      event: 'boot.activation_safety_failed',
      reason: webOriginsFailure.reason,
      nodeEnv: env.NODE_ENV,
      message: webOriginsFailure.message,
    }),
  );
  process.exit(1);
}

// Third activation-safety gate (#169): SUPABASE_JWT_ISSUER required in
// non-dev/test. Factored into ./activation-safety.ts so the predicate
// is unit-testable without booting Fastify. Same exclusion-list posture
// as the TRUSTED_PROXY_HOPS and WEB_ORIGINS gates above — fails CLOSED
// on unknown NODE_ENV values. Also catches an empty-string env var: the
// loadEnv() layer coerces '' → undefined via emptyToUndefined() before
// Zod sees it, so an operator who sets SUPABASE_JWT_ISSUER='' on the
// Railway service hits THIS gate rather than silently booting without
// the issuer claim being checked by jose.jwtVerify in context.ts.
const jwtIssuerFailure = checkJwtIssuer(env);
if (jwtIssuerFailure) {
  console.error(
    JSON.stringify({
      event: 'boot.activation_safety_failed',
      reason: jwtIssuerFailure.reason,
      nodeEnv: env.NODE_ENV,
      message: jwtIssuerFailure.message,
    }),
  );
  process.exit(1);
}

// Reuse the same Upstash client the per-request tRPC contexts use. The
// prior shape constructed a separate `new Redis({...})` here, doubling
// the credential surface in memory for no functional gain (Upstash REST
// is stateless). PR #56 r1 security-reviewer L-redis-dup.
const outerRedis = getOrBuildRedis(env) as unknown as RedisClient;

// Outer-hook global ceiling. CLAUDE.md pre-launch TODO specifies
// 600/min as the global anti-DDoS floor; tightened from the prior
// 1200/min to the stated band. Cross-instance via Upstash REST (the
// same `outerRedis` the per-request tRPC contexts use). The co-NAT
// hybrid-keying posture lives one layer down in `publicLimit`; this
// IP-only ceiling is defense-in-depth above it.
const OUTER_HOOK_PER_MIN = 600;

// Mutation-burst global cap. CLAUDE.md pre-launch TODO: "10 mutations/
// min keyed on ctx.userId (fallback IP)". The Fastify layer runs BEFORE
// the tRPC plugin builds the per-request context, so there is no
// ctx.userId here — the IP /24 (`request.ip` normalised through
// `normalizeIpToCidr`) IS the fallback-IP branch of the user's spec.
// The per-procedure `mutationLimit` middleware (rate-limit.ts) still
// keys on `ctx.userId` for the authed tightening above this floor.
// Separate counter namespace (`__mutation__`) so a user's 60/min on
// /trpc/auth.session (public tier) and this 10/min mutation burst
// never share a key.
const MUTATION_BURST_PER_MIN = 10;

// Auth-session global cap. CLAUDE.md pre-launch TODO: "60 req/min per
// IP on /trpc/auth.session". The per-procedure `publicLimit` in
// `routers/auth.ts` DOES hybrid-key (userId when authed, IP /24 when
// anon) — this Fastify-layer check runs before context is built and
// is strictly IP-keyed so it covers the pre-sign-in polling case.
// Separate counter namespace (`__auth_session__`).
const AUTH_SESSION_PER_MIN = 60;
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
//
// `commit` resolves the deployed git SHA (short form) from
// RAILWAY_GIT_COMMIT_SHA, else 'unknown'. Railway's git auto-deploy
// populates that env var on the running container; local dev lands on
// 'unknown'. See packages/shared/src/deploy-sha.ts for the hex guard.
app.log.info(
  {
    event: 'boot.started',
    host: env.HOST,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    trustProxyHops: env.TRUSTED_PROXY_HOPS ?? null,
    commit: resolveDeploySha(),
  },
  'diktat-api booting',
);

// Telegram alerter for 🔴 server-error alerts (see onError below). No-op when
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset. onFailure logs a coarse
// status ONLY — the alerter never hands us the token or the request URL.
const alerter = makeAlerter({
  botToken: env.TELEGRAM_BOT_TOKEN,
  chatId: env.TELEGRAM_CHAT_ID,
  onFailure: ({ status, severity }) =>
    app.log.warn({ event: 'telegram_alert_failed', status, severity }, 'telegram alert failed'),
});
// hasToken/hasChatId (booleans only — no credential values) make a "set one but
// not both" misconfiguration visible in the boot log instead of silently
// disabled.
app.log.info(
  {
    event: 'alerts.telegram',
    enabled: alerter.enabled,
    hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
    hasChatId: Boolean(env.TELEGRAM_CHAT_ID),
  },
  'telegram alerts',
);

await app.register(cors, {
  // Three-way decision — absent header pass (server-to-server), literal
  // `Origin: null` deny (browser opaque-origin contexts), allow-list
  // check for everything else. See `./cors-origin.ts` for the full
  // reasoning; the callback stays this thin so the branches are only
  // described once. PR #82 round-1 security-reviewer MED #168.
  origin: (origin, cb) => {
    const decision = decideCorsOrigin(origin, env.WEB_ORIGINS);
    cb(null, decision.allowed);
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
    { event: 'outer_hook.resolved_ip', cidr: ipCidr, path: pathOnly },
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
    // FST_ERR_REP_ALREADY_SENT.
    //
    // Body shape in `outer-hook.ts` is unit-testable without booting
    // Fastify. The numeric ceiling is deliberately NOT disclosed (RFC
    // 6585 §4: Retry-After alone is sufficient; disclosing the limit
    // lets an adversary calibrate requests to stay just under it).
    return reply
      .code(429)
      .header('Retry-After', String(result.retryAfterSec))
      .send(buildOuterHookBlockedBody());
  }

  // tRPC fastify adapter supports procedure batching: a client can
  // request multiple procedures in one URL like
  //   /trpc/auth.session,other.proc?batch=1&input=…
  // Only the FIRST segment carries the `/trpc/` prefix; subsequent
  // segments are bare procedure names. The band checks below must
  // compare against the comma-separated procedure list, not an exact
  // string equality against `pathOnly`, or batched requests silently
  // bypass the Fastify-layer floor.
  // (CI security-reviewer PR #276 MEDIUM.)
  const procsInBatch = pathOnly.startsWith('/trpc/')
    ? pathOnly.slice('/trpc/'.length).split(',')
    : [];

  // Pre-launch band 2 — auth-session cap (60/min per IP /24).
  // CLAUDE.md pre-launch TODO. The per-procedure `publicLimit` in
  // routers/auth.ts further tightens via hybrid IP+userId keying once
  // the tRPC context is built; this floor runs before context so it
  // covers the pre-sign-in polling case.
  if (procsInBatch.includes('auth.session')) {
    const authResult = await checkAuthSessionHook({
      redis: outerRedis,
      ipCidr,
      perMin: AUTH_SESSION_PER_MIN,
    });
    if (!authResult.allowed) {
      // Deny-telemetry — the global outer hook already logs
      // `rate_limit.redis_down` on fail-open; mirror a structured
      // deny-event here so a Fastify-layer 429 is observable in
      // Axiom/console. We do NOT log `ipCidr` at this layer (network
      // identifier; GDPR-adjacent in some jurisdictions). (CI
      // security-reviewer PR #276 LOW.)
      console.warn(
        JSON.stringify({
          event: 'rate_limit.deny',
          tier: 'auth_session',
          retryAfterSec: authResult.retryAfterSec,
        }),
      );
      return reply
        .code(429)
        .header('Retry-After', String(authResult.retryAfterSec))
        .send(buildOuterHookBlockedBody());
    }
  }

  // Pre-launch band 3 — mutation burst cap (10/min per IP /24).
  // CLAUDE.md pre-launch TODO. tRPC fastify adapter routes mutations
  // over POST and queries over GET, so `method === 'POST' && path
  // startsWith '/trpc/'` is the reliable mutation-only discriminator
  // at the Fastify layer. The per-procedure `mutationLimit` middleware
  // tightens by `ctx.userId` above this floor once the context is
  // built. The `clientKey` idempotency path in individual mutation
  // routers (feed.recordShift, take5.recordShift, …) still applies
  // after a 429 here, so a resumed client reusing the same key will
  // land on the server's 23505 idempotency branch when the budget
  // clears.
  //
  // Known limitation (CI security-reviewer PR #276 LOW): a batched
  // POST (`/trpc/proc1,proc2`) counts as a SINGLE increment but
  // executes N mutations. The per-procedure `mutationLimit`
  // middleware (ctx.userId-keyed) still fires N times individually,
  // so the per-user tightening above this floor is NOT bypassed —
  // only the IP-keyed Fastify floor under-counts. Acceptable pre-
  // launch; revisit (either count batch depth into the Lua INCR or
  // reject batched POSTs with 400) before production-scale load.
  if (request.method === 'POST' && procsInBatch.length > 0) {
    const mutResult = await checkMutationBurstHook({
      redis: outerRedis,
      ipCidr,
      perMin: MUTATION_BURST_PER_MIN,
    });
    if (!mutResult.allowed) {
      console.warn(
        JSON.stringify({
          event: 'rate_limit.deny',
          tier: 'mutation_burst',
          retryAfterSec: mutResult.retryAfterSec,
        }),
      );
      return reply
        .code(429)
        .header('Retry-After', String(mutResult.retryAfterSec))
        .send(buildOuterHookBlockedBody());
    }
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
      // Log the shape we control plus the underlying PostgREST/PG error
      // `code` only. `error.cause` holds raw Supabase errors whose
      // message/details/hint may carry SQL text or row data — those three
      // subfields are stripped by the Pino `redact` config above. The
      // `code` (e.g. `42501`, `PGRST202`) is not redacted: it is the
      // diagnostic needle for DB grant/migration failures and is PII-free.
      const causeCode = (error.cause as { code?: string } | undefined)?.code;
      app.log.error(
        {
          code: error.code,
          causeCode,
          path,
          message: error.message,
        },
        'tRPC error',
      );

      // 🔴 alert on SERVER faults only — client-fault codes (rate-limit, bad
      // input, auth, not-found) are expected noise, not incidents. Detail is
      // PII-free by construction: path + tRPC code + the DB error code only
      // (same redaction reasoning as the log above — never the message/rows).
      // Fire-and-forget: alert() never throws, so a bad token can't break the
      // error path. Dedup collapses a flapping endpoint to one alert / window.
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        const where = path ?? '<no-path>';
        void alerter.alert(
          'error',
          'API 500',
          `${where} · ${error.code}${causeCode ? ` · db=${causeCode}` : ''}`,
          { dedupKey: `api:${where}:${causeCode ?? error.code}` },
        );
      }
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

app.listen({ port: env.PORT, host: env.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
