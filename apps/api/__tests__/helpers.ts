import type { Context } from '../src/context.js';
import type { Env } from '../src/env.js';

const TEST_ENV: Env = {
  PORT: 4000,
  HOST: '0.0.0.0',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_JWT_SECRET: 'jwt-secret',
  SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
  WEB_ORIGINS: ['http://localhost:3000'],
  NODE_ENV: 'test',
};

/**
 * Build a fake Supabase query builder. The fluent chain is captured so
 * tests can assert filter usage; the terminal `maybeSingle`, `then`, etc.
 * resolve to `result`.
 */
export interface FakeQueryResult<T> {
  data: T | null;
  error: { code?: string; message: string } | null;
}

export function fakeDb<T>(table: string, result: FakeQueryResult<T>) {
  const calls: { table: string; ops: { op: string; args: unknown[] }[] } = { table, ops: [] };

  const builder: Record<string, unknown> = {};

  const resolveValue = result;
  // Methods that return the builder for chaining.
  for (const op of [
    'select',
    'eq',
    'lt',
    'gt',
    'order',
    'limit',
    'update',
    'insert',
    'upsert',
    'delete',
  ]) {
    builder[op] = (...args: unknown[]) => {
      calls.ops.push({ op, args });
      return builder;
    };
  }
  // Terminal methods.
  builder.maybeSingle = () => Promise.resolve(resolveValue);
  builder.single = () => Promise.resolve(resolveValue);
  builder.then = (resolve: (v: FakeQueryResult<T>) => unknown) =>
    Promise.resolve(resolve(resolveValue));

  const db = {
    from: (t: string) => {
      if (t !== table) {
        throw new Error(`fakeDb: unexpected table "${t}", expected "${table}"`);
      }
      return builder;
    },
  };

  return { db, calls };
}

/**
 * Construct a tRPC context with sensible defaults for tests. Pass a fake
 * Supabase client built via `fakeDb` to drive responses.
 */
export function makeCtx(overrides: Partial<Context> & { db: unknown }): Context {
  return {
    env: TEST_ENV,
    userId: 'user-123',
    role: 'authenticated',
    bearerToken: 'fake-token',
    ...(overrides as Partial<Context>),
    db: overrides.db as Context['db'],
  };
}
