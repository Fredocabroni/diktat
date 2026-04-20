import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';

describe('tribesRouter.list', () => {
  it('returns the seeded tribes sorted by name', async () => {
    const rows = [
      {
        id: 't-1',
        slug: 'accelerationists',
        name: 'Accelerationists',
        description: 'a',
        manifesto: 'm',
      },
      { id: 't-2', slug: 'libertarians', name: 'Libertarians', description: 'b', manifesto: 'm' },
    ];
    const { db, calls } = fakeDb('tribes', { data: rows, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.tribes.list()).toEqual(rows);
    const orderCall = calls.ops.find((op) => op.op === 'order');
    expect(orderCall?.args).toEqual(['name', { ascending: true }]);
  });

  it('works without auth (public query)', async () => {
    const { db } = fakeDb('tribes', { data: [], error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));

    await expect(caller.tribes.list()).resolves.toEqual([]);
  });

  it('wraps upstream errors as INTERNAL_SERVER_ERROR', async () => {
    const { db } = fakeDb('tribes', {
      data: null,
      error: { code: '500', message: 'boom' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.tribes.list()).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.tribes.list()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('tribesRouter.join', () => {
  const validTribeId = 'a0000000-0000-0000-0000-000000000001';

  it('UNAUTHORIZED for anon callers', async () => {
    const { db } = fakeDb('tribe_memberships', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));

    await expect(caller.tribes.join({ tribeId: validTribeId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects non-uuid tribe ids', async () => {
    const { db } = fakeDb('tribe_memberships', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.tribes.join({ tribeId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('inserts the membership with server-safe defaults', async () => {
    const { db, calls } = fakeDb('tribe_memberships', {
      data: { user_id: 'user-123', tribe_id: validTribeId, joined_at: '2026-04-20T12:00:00Z' },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.tribes.join({ tribeId: validTribeId });
    expect(result).toMatchObject({
      userId: 'user-123',
      tribeId: validTribeId,
      alreadyJoined: false,
    });

    const insertCall = calls.ops.find((op) => op.op === 'insert');
    expect(insertCall?.args[0]).toMatchObject({
      user_id: 'user-123',
      tribe_id: validTribeId,
      weekly_ap: 0,
      is_primary: false,
    });
  });

  it('treats duplicate membership as idempotent', async () => {
    const { db } = fakeDb('tribe_memberships', {
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.tribes.join({ tribeId: validTribeId })).resolves.toMatchObject({
      userId: 'user-123',
      tribeId: validTribeId,
      alreadyJoined: true,
    });
  });

  it('wraps non-conflict errors as INTERNAL_SERVER_ERROR', async () => {
    const { db } = fakeDb('tribe_memberships', {
      data: null,
      error: { code: '500', message: 'db down' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.tribes.join({ tribeId: validTribeId })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
