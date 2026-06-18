import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { type FakeQueryResult, makeCtx } from '../helpers.js';

// auth.session pivots to `rpc('get_user_self').maybeSingle()` per
// migration 20260618170000. The fake below stubs the RPC return.
function fakeRpcSelfDb(result: FakeQueryResult<unknown>): Context['db'] {
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'lt', 'lte', 'gt', 'gte', 'order', 'limit']) {
    builder[op] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  builder.then = (resolve: (v: FakeQueryResult<unknown>) => unknown) =>
    Promise.resolve(resolve(result));
  return {
    rpc: (_fn: string) => builder,
    from: () => {
      throw new Error('fakeRpcSelfDb: did not expect a from() call');
    },
  } as unknown as Context['db'];
}

describe('authRouter.session', () => {
  it('returns null when ctx has no userId', async () => {
    const db = fakeRpcSelfDb({ data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));

    expect(await caller.auth.session()).toBeNull();
  });

  it('returns userId + onboardedAt for an authed user', async () => {
    const db = fakeRpcSelfDb({
      data: { id: 'user-123', onboarded_at: '2026-04-20T10:00:00Z' },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const session = await caller.auth.session();
    expect(session).toEqual({
      userId: 'user-123',
      onboardedAt: '2026-04-20T10:00:00Z',
    });
  });

  it('returns null onboardedAt when row not yet flagged', async () => {
    const db = fakeRpcSelfDb({
      data: { id: 'user-123', onboarded_at: null },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.auth.session()).toEqual({
      userId: 'user-123',
      onboardedAt: null,
    });
  });

  it('degrades gracefully when the rpc errors', async () => {
    const db = fakeRpcSelfDb({
      data: null,
      error: { message: 'connection lost' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.auth.session()).toEqual({
      userId: 'user-123',
      onboardedAt: null,
    });
  });
});
