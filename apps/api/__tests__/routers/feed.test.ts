import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';

const TOPIC_ID = '11111111-1111-1111-1111-111111111111';

describe('feedRouter.recordShift', () => {
  it('inserts the shift and returns the row in camelCase', async () => {
    const row = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      topic_id: TOPIC_ID,
      before_position: 0,
      after_position: 1,
      created_at: '2026-04-25T00:00:00.000Z',
    };
    const { db } = fakeDb('opinion_shifts', { data: row, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      beforePosition: 0,
      afterPosition: 1,
    });

    expect(result).toEqual({
      id: row.id,
      topicId: row.topic_id,
      beforePosition: 0,
      afterPosition: 1,
      createdAt: row.created_at,
    });
  });

  it('maps a 23503 fk_violation to NOT_FOUND', async () => {
    const { db } = fakeDb('opinion_shifts', {
      data: null,
      error: { code: '23503', message: 'fk violation' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        beforePosition: 0,
        afterPosition: -1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects out-of-range positions before hitting the DB', async () => {
    const { db, calls } = fakeDb('opinion_shifts', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        beforePosition: 0,
        afterPosition: 3 as 0 | 1 | 2,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]); // never touched the table
  });

  it('rejects a non-uuid topicId before hitting the DB', async () => {
    const { db, calls } = fakeDb('opinion_shifts', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: 'not-a-uuid',
        beforePosition: 0,
        afterPosition: 0,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });
});
