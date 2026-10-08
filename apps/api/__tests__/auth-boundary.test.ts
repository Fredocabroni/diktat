import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/context.js';
import { appRouter } from '../src/routers/index.js';

// Closes #178 — "absent Origin + no bearer → 401 on protected tRPC
// procedure". The CORS layer (`decideCorsOrigin` in #174) deliberately
// allows requests with no `Origin` header because that is how legitimate
// server-to-server callers (Railway healthcheck, operator curl, future
// webhooks) look. The invariant the queue entry pins is that CORS is
// NEVER the only gate for a protected read: an unauthenticated caller
// with no bearer must still receive a `401 UNAUTHORIZED` from the tRPC
// `protectedProcedure` middleware, regardless of what the CORS layer
// does with the response headers.
//
// A regression that silently drops `requireAuthed` from the middleware
// stack — or that lets `ctx.userId` be set from an unverified header —
// would be invisible to a CORS-only test. This file is that defence.
//
// Why not an app.inject() Fastify test. `apps/api/src/server.ts` top-
// level-awaits `.listen()` at module scope, so importing it binds a port.
// Factoring out a `buildApp()` helper for tests would be a production
// code change — explicitly out of #178's scope (test-only). Instead this
// test shapes a FastifyRequest-ish object directly, calls `buildContext`
// — the same code path the real Fastify pipeline runs — and exercises
// the resulting context through `appRouter.createCaller`. That covers
// the auth-middleware boundary end-to-end from headers to error code.

interface MockRequestInit {
  readonly authorization?: string;
  readonly origin?: string;
  readonly ip?: string;
}

function mockRequest(init: MockRequestInit = {}): FastifyRequest {
  const headers: Record<string, string> = {};
  if (init.authorization !== undefined) headers.authorization = init.authorization;
  if (init.origin !== undefined) headers.origin = init.origin;
  // Cast — only the fields `buildContext` reads are populated. The real
  // FastifyRequest has 100+ fields the test does not need.
  return {
    headers,
    ip: init.ip ?? '198.51.100.42',
  } as unknown as FastifyRequest;
}

// Minimal env — fields buildContext + userScopedClient actually touch.
// Values are intentionally fake; the test never makes a real HTTP call
// (buildContext constructs a Supabase client but doesn't invoke it, and
// the protected procedure throws before any downstream query runs).
const TEST_ENV = {
  PORT: 4000,
  HOST: '0.0.0.0',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_JWT_SECRET: 'jwt-secret',
  SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
  UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  WEB_ORIGINS: ['https://diktat-web1.vercel.app'],
  NODE_ENV: 'test' as const,
};

describe('auth boundary — absent Origin + no bearer → UNAUTHORIZED', () => {
  it('no bearer + no Origin on `user.me` → UNAUTHORIZED (401 on the wire)', async () => {
    // The headline case for #178. A caller with neither auth nor Origin
    // hits a protected procedure. `requireAuthed` must throw before any
    // resolver body runs.
    const req = mockRequest({});
    const ctx = await buildContext(TEST_ENV, req);

    expect(ctx.userId).toBeNull();
    expect(ctx.role).toBe('anon');

    const caller = appRouter.createCaller(ctx);
    await expect(caller.user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('no bearer + a legitimate Origin on `user.me` → UNAUTHORIZED (CORS not a substitute for auth)', async () => {
    // Even with an allow-listed Origin header, protectedProcedure
    // enforces auth. CORS allow-listing is a browser-level gate on
    // response-header emission, not an auth decision.
    const req = mockRequest({ origin: 'https://diktat-web1.vercel.app' });
    const ctx = await buildContext(TEST_ENV, req);

    const caller = appRouter.createCaller(ctx);
    await expect(caller.user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('malformed bearer + no Origin → UNAUTHORIZED (buildContext swallows the JWT error → anon)', async () => {
    // buildContext intentionally catches jose errors and demotes the
    // request to anon (`userId=null`, `role='anon'`) rather than
    // throwing, so public procedures stay callable with a bad bearer.
    // The protected gate then fires on anon the same way as no-bearer.
    const req = mockRequest({ authorization: 'Bearer not-a-real-jwt' });
    const ctx = await buildContext(TEST_ENV, req);

    expect(ctx.userId).toBeNull();
    expect(ctx.role).toBe('anon');

    const caller = appRouter.createCaller(ctx);
    await expect(caller.user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('no bearer on a different protected procedure (`wallet.balance`) → UNAUTHORIZED', async () => {
    // Second procedure to confirm `requireAuthed` is reached from more
    // than one router — a single failing procedure would not prove the
    // middleware is universally applied. `wallet.balance` is a read on a
    // different router, so the test catches a mis-wire where only one
    // router gets `protectedProcedure`.
    const req = mockRequest({});
    const ctx = await buildContext(TEST_ENV, req);

    const caller = appRouter.createCaller(ctx);
    await expect(caller.wallet.balance()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('empty-string Authorization header → treated as absent → UNAUTHORIZED', async () => {
    // Defence against a client that stringifies `undefined` and sends
    // `Authorization: ` with no value. `extractBearer` should treat an
    // empty header the same as no header; the protected gate fires
    // either way.
    const req = mockRequest({ authorization: '' });
    const ctx = await buildContext(TEST_ENV, req);

    expect(ctx.userId).toBeNull();
    expect(ctx.role).toBe('anon');

    const caller = appRouter.createCaller(ctx);
    await expect(caller.user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('absent Origin alone does NOT trigger an UNAUTHORIZED — this would mean the CORS layer became the auth gate', async () => {
    // Negative control: the test above asserts that no-bearer + no-Origin
    // 401s. This test asserts the mirror: with a valid bearer (simulated
    // by setting ctx.userId + ctx.role directly through a crafted buildContext
    // call isn't possible without a real JWT, so we test the invariant via
    // the caller directly), a protected procedure proceeds past the
    // middleware gate — i.e. the absence of Origin by itself never
    // promotes the request to UNAUTHORIZED. We prove this by hand-
    // constructing a context with userId set + role='authenticated' and
    // asserting the middleware passes (resolver body may still fail on
    // the fake DB, but it does NOT throw UNAUTHORIZED).
    const req = mockRequest({});
    const anonCtx = await buildContext(TEST_ENV, req);
    const authedCtx = {
      ...anonCtx,
      userId: 'f0000000-0000-0000-0000-000000000001',
      role: 'authenticated',
    };

    const caller = appRouter.createCaller(authedCtx);
    // The resolver will likely fail on the fake supabase client, but the
    // failure mode we care about is NOT `UNAUTHORIZED` — any other error
    // is acceptable. (If it did throw UNAUTHORIZED, the middleware
    // promoted a no-Origin authed request to anon — bug.)
    await expect(caller.user.me()).rejects.toSatisfy(
      (err) => (err as { code?: string }).code !== 'UNAUTHORIZED',
    );
  });
});
