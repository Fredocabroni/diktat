import cors from '@fastify/cors';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';

import { buildContext } from './context.js';
import { loadEnv } from './env.js';
import { appRouter, type AppRouter } from './routers/index.js';

const env = loadEnv();

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
