import cors from '@fastify/cors';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { Redis } from '@upstash/redis';
import Fastify from 'fastify';

import { buildContext, normalizeIpToCidr, type RedisClient } from './context.js';
import { loadEnv } from './env.js';
import { checkGlobalOuterHook } from './rate-limit.js';
import { appRouter, type AppRouter } from './routers/index.js';

const env = loadEnv();
const outerRedis: RedisClient = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
}) as unknown as RedisClient;

// Outer-hook global ceiling. M5 design's anti-DDoS floor; tuned to a
// generous human-burst per /24 NAT block. Tighten in M6 if real abuse
// shows up post-launch.
const OUTER_HOOK_PER_MIN = 1_200;

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
});

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
// `request.ip` is populated. Without `trustProxy` (currently NOT set;
// see context.ts:normalizeIpToCidr() topology note), `request.ip` is
// the immediate TCP peer. Local dev: 127.0.0.1. Behind Railway/Vercel:
// must wire trustProxy at Fastify construction or every IP-keyed
// counter pools to the proxy IP.
app.addHook('onRequest', async (request, reply) => {
  if (OUTER_HOOK_EXEMPT_PATHS.has(request.url) || request.url.startsWith('/health?')) {
    return;
  }
  const ipCidr = normalizeIpToCidr(request.ip ?? '');
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
    return reply
      .code(429)
      .send({ error: 'Too many requests.', limit: OUTER_HOOK_PER_MIN, window: '60s' });
  }
});

app.get('/health', async () => ({ status: 'ok', service: 'diktat-api' }));

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => buildContext(env, req),
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
