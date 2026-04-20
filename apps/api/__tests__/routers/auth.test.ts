import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';

describe('authRouter.session', () => {
  it('returns null when ctx has no userId', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));

    expect(await caller.auth.session()).toBeNull();
  });

  it('returns userId + onboardedAt for an authed user', async () => {
    const { db, calls } = fakeDb('users', {
      data: { id: 'user-123', onboarded_at: '2026-04-20T10:00:00Z' },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const session = await caller.auth.session();
    expect(session).toEqual({
      userId: 'user-123',
      onboardedAt: '2026-04-20T10:00:00Z',
    });

    // Verify the row filter was applied to the right user.
    const eqCall = calls.ops.find((op) => op.op === 'eq');
    expect(eqCall?.args).toEqual(['id', 'user-123']);
  });

  it('returns null onboardedAt when row not yet flagged', async () => {
    const { db } = fakeDb('users', {
      data: { id: 'user-123', onboarded_at: null },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.auth.session()).toEqual({
      userId: 'user-123',
      onboardedAt: null,
    });
  });

  it('degrades gracefully when the lookup errors', async () => {
    const { db } = fakeDb('users', {
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
