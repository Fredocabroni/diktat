// tRPC request context. Runs on every request. Inexpensive: one HS256
// JWT verify (microseconds), one Supabase client construction (object
// literal, no I/O). Service-role client is constructed lazily — only
// routers that opt in see it.

import { verifyJwt } from '@diktat/auth';
import type { FastifyRequest } from 'fastify';

import type { Env } from './env.js';
import { userScopedClient, type DbClient } from './supabase.js';

export interface Context {
  readonly env: Env;
  readonly userId: string | null;
  readonly role: string;
  readonly db: DbClient;
  readonly bearerToken: string | null;
}

function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function buildContext(env: Env, req: FastifyRequest): Promise<Context> {
  const rawBearer = extractBearer(req.headers.authorization);

  let userId: string | null = null;
  let role = 'anon';
  let verifiedToken: string | null = null;

  if (rawBearer) {
    try {
      const claims = await verifyJwt(rawBearer, {
        secret: env.SUPABASE_JWT_SECRET,
        ...(env.SUPABASE_JWT_ISSUER ? { issuer: env.SUPABASE_JWT_ISSUER } : {}),
      });
      userId = claims.sub;
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

  return { env, userId, role, db, bearerToken: verifiedToken };
}
