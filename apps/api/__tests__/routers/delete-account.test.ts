// Tests for user.deleteAccount. The mutation now gates on three
// server-side invariants (migration 20261110000000's
// delete_my_account RPC + a Redis matchmaking-queue check in the
// resolver) before invoking auth.admin.deleteUser(ctx.userId), which
// in turn CASCADEs through public.users on every private 1:1 table
// and anonymises ap_transactions via the FK's ON DELETE SET NULL.

import type { Context } from '../../src/context.js';
import { describe, expect, it, vi } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeRedis, makeCtx } from '../helpers.js';

// Service-role client is constructed inside the mutation handler. We
// stub `createClient` on the Supabase module so the handler receives
// a client with a stubbed `auth.admin.deleteUser`.
vi.mock('@supabase/supabase-js', async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    createClient: vi.fn(() => ({
      auth: {
        admin: {
          deleteUser: vi.fn(async (id: string) => {
            if (id === 'provoke-fail') {
              return { data: null, error: { message: 'provoked', status: 500 } };
            }
            return { data: null, error: null };
          }),
        },
      },
    })),
  };
});

// Minimal db stub carrying only the `rpc('delete_my_account')` path.
// The resolver's RPC call pattern is `ctx.db.rpc('delete_my_account')`
// returning `{ data, error }`.
function dbWithDeleteRpc(
  outcome: { data?: unknown; error?: { code?: string; message: string } | null },
  calls?: string[],
): Context['db'] {
  return {
    from: (t: string) => {
      throw new Error(`deleteAccount test: unexpected from("${t}")`);
    },
    rpc: (fn: string) => {
      if (fn === 'delete_my_account') {
        calls?.push(fn);
        return Promise.resolve({ data: outcome.data ?? null, error: outcome.error ?? null });
      }
      throw new Error(`deleteAccount test: unexpected rpc("${fn}")`);
    },
  } as unknown as Context['db'];
}

describe('user.deleteAccount — happy path', () => {
  it('calls the RPC then auth.admin.deleteUser(ctx.userId) and returns outcome=deleted', async () => {
    const rpcCalls: string[] = [];
    const db = dbWithDeleteRpc({ data: { ok: true, scrubbed: 1 }, error: null }, rpcCalls);
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.user.deleteAccount();
    expect(r).toEqual({ outcome: 'deleted' });
    expect(rpcCalls).toEqual(['delete_my_account']);
  });

  it('maps auth-admin failure (after a successful RPC) to INTERNAL_SERVER_ERROR with a generic message', async () => {
    const db = dbWithDeleteRpc({ data: { ok: true }, error: null });
    const caller = appRouter.createCaller(
      makeCtx({ db, redis: fakeRedis(), userId: 'provoke-fail' }),
    );
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Could not delete account. Try again.',
    });
  });
});

describe('user.deleteAccount — server-side gates', () => {
  it('refuses with FORBIDDEN when the caller is queued in matchmaking (trivia)', async () => {
    const rpcCalls: string[] = [];
    const db = dbWithDeleteRpc({ data: { ok: true }, error: null }, rpcCalls);
    const redis = fakeRedis();
    await redis.zadd('mm:trivia:queue', { score: 100, member: 'user-123' });
    const caller = appRouter.createCaller(makeCtx({ db, redis }));
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Leave the matchmaking queue, then delete your account.',
    });
    // RPC was never invoked — gate ran first.
    expect(rpcCalls).toEqual([]);
  });

  it('refuses with FORBIDDEN when the caller is queued in matchmaking (open_debate)', async () => {
    const db = dbWithDeleteRpc({ data: { ok: true }, error: null });
    const redis = fakeRedis();
    await redis.zadd('mm:open_debate:queue', { score: 100, member: 'user-123' });
    const caller = appRouter.createCaller(makeCtx({ db, redis }));
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("maps RPC P0001 'recent_auth_required' → UNAUTHORIZED with the re-sign-in message", async () => {
    const db = dbWithDeleteRpc({
      data: null,
      error: { code: 'P0001', message: 'delete_my_account: recent_auth_required' },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Sign in again to delete your account.',
    });
  });

  it("maps RPC P0001 'in_live_battle' → FORBIDDEN with a finish-the-battle message", async () => {
    const db = dbWithDeleteRpc({
      data: null,
      error: { code: 'P0001', message: 'delete_my_account: in_live_battle' },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Finish your current battle, then delete your account.',
    });
  });

  it('maps RPC sqlstate 28000 → UNAUTHORIZED', async () => {
    const db = dbWithDeleteRpc({
      data: null,
      error: { code: '28000', message: 'unauth' },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('maps unknown RPC error → INTERNAL_SERVER_ERROR with a generic message', async () => {
    const db = dbWithDeleteRpc({
      data: null,
      error: { code: 'XX000', message: 'boom' },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Could not delete account. Try again.',
    });
  });
});

describe('user.deleteAccount — age-gate exemption', () => {
  it('is EXEMPT from the mutation-wide age-gate (an unverified or blocked user must still be able to self-delete)', async () => {
    const db = dbWithDeleteRpc({ data: { ok: true }, error: null });
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'unverified' as const }),
      }),
    );
    await expect(caller.user.deleteAccount()).resolves.toEqual({ outcome: 'deleted' });
  });

  it('is EXEMPT from the age-gate even when the account is terminally blocked', async () => {
    const db = dbWithDeleteRpc({ data: { ok: true }, error: null });
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'blocked' as const }),
      }),
    );
    await expect(caller.user.deleteAccount()).resolves.toEqual({ outcome: 'deleted' });
  });
});
