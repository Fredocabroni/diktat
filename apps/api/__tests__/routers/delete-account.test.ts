// Tests for user.deleteAccount: the mutation calls
// supabase.auth.admin.deleteUser(ctx.userId); CASCADE on
// public.users.id → auth.users.id handles everything else;
// ap_transactions anonymizes via migration 20261110000000's
// FK change (ON DELETE SET NULL).

import { describe, expect, it, vi } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeRedis, makeCtx } from '../helpers.js';

// serviceRoleClient is constructed inside the mutation handler. We
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

describe('user.deleteAccount', () => {
  it('calls auth.admin.deleteUser(ctx.userId) and returns outcome=deleted', async () => {
    const caller = appRouter.createCaller(makeCtx({ db: {} as never, redis: fakeRedis() }));
    const r = await caller.user.deleteAccount();
    expect(r).toEqual({ outcome: 'deleted' });
  });

  it('maps auth-admin failure to INTERNAL_SERVER_ERROR with a generic message', async () => {
    const caller = appRouter.createCaller(
      makeCtx({ db: {} as never, redis: fakeRedis(), userId: 'provoke-fail' }),
    );
    await expect(caller.user.deleteAccount()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Could not delete account. Try again.',
    });
  });

  it('is EXEMPT from the mutation-wide age-gate (an unverified or blocked user must still be able to self-delete)', async () => {
    // Even with age unverified, the mutation goes through. The
    // age-gate middleware exempts `user.deleteAccount` by path.
    const caller = appRouter.createCaller(
      makeCtx({
        db: {} as never,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'unverified' as const }),
      }),
    );
    await expect(caller.user.deleteAccount()).resolves.toEqual({ outcome: 'deleted' });
  });

  it('is EXEMPT from the age-gate even when the account is terminally blocked', async () => {
    const caller = appRouter.createCaller(
      makeCtx({
        db: {} as never,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'blocked' as const }),
      }),
    );
    await expect(caller.user.deleteAccount()).resolves.toEqual({ outcome: 'deleted' });
  });
});
