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

describe('feedRouter.list', () => {
  const DROP_ROW = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    headline: 'Senate votes 52-48 on the CR',
    source_title: 'Senate passes FY27 continuing resolution',
    summary: 'Cloture filed Monday; final passage Thursday after a week of amendments.',
    primary_source_url: 'https://www.congress.gov/bill/118hr1234',
    category: 'congress',
    drop_at: '2026-06-17T00:00:00.000Z',
    dedup_cluster_id: '00000000-0000-0000-0000-000000000001',
    curation_mode: 'auto_dominant',
    is_block_exhausted: false,
    additional_sources: [],
  };

  it('returns ≤1 row in default mode with the right column projection', async () => {
    const { db, calls } = fakeDb('news_topics', { data: [DROP_ROW], error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.list();

    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]).toEqual({
      id: DROP_ROW.id,
      headline: DROP_ROW.headline,
      sourceTitle: DROP_ROW.source_title,
      summary: DROP_ROW.summary,
      primarySourceUrl: DROP_ROW.primary_source_url,
      category: DROP_ROW.category,
      dropAt: DROP_ROW.drop_at,
      dedupClusterId: DROP_ROW.dedup_cluster_id,
      curationMode: DROP_ROW.curation_mode,
      isBlockExhausted: false,
      additionalSources: [],
    });
    // Query shape: select → eq(is_drop, true) → lte(drop_at, cursor) → order desc → limit 1.
    const ops = calls.ops.map((o) => o.op);
    expect(ops).toEqual(['select', 'eq', 'lte', 'order', 'limit']);
    const eqArgs = calls.ops.find((o) => o.op === 'eq')?.args;
    expect(eqArgs).toEqual(['is_drop', true]);
    const limitArgs = calls.ops.find((o) => o.op === 'limit')?.args;
    expect(limitArgs).toEqual([1]);
    const orderArgs = calls.ops.find((o) => o.op === 'order')?.args;
    expect(orderArgs?.[0]).toBe('drop_at');
    expect((orderArgs?.[1] as { ascending: boolean }).ascending).toBe(false);
  });

  it('returns an empty array when no Drop has been published yet', async () => {
    const { db } = fakeDb('news_topics', { data: [], error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.list();
    expect(result.topics).toEqual([]);
  });

  it('passes a provided cursor through to lte (archive pagination forward-compat)', async () => {
    const { db, calls } = fakeDb('news_topics', { data: [], error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const cursor = '2026-06-10T00:00:00.000Z';
    await caller.feed.list({ limit: 20, cursor });

    const lteArgs = calls.ops.find((o) => o.op === 'lte')?.args;
    expect(lteArgs).toEqual(['drop_at', cursor]);
    const limitArgs = calls.ops.find((o) => o.op === 'limit')?.args;
    expect(limitArgs).toEqual([20]);
  });

  it('defaults the cursor to now when none is provided', async () => {
    const { db, calls } = fakeDb('news_topics', { data: [], error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const before = Date.now();
    await caller.feed.list();
    const after = Date.now();

    const lteArgs = calls.ops.find((o) => o.op === 'lte')?.args;
    expect(lteArgs?.[0]).toBe('drop_at');
    const cursorMs = new Date(lteArgs?.[1] as string).getTime();
    expect(cursorMs).toBeGreaterThanOrEqual(before);
    expect(cursorMs).toBeLessThanOrEqual(after);
  });

  it('rejects an out-of-range limit before hitting the DB', async () => {
    const { db, calls } = fakeDb('news_topics', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list({ limit: 51 })).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('rejects a malformed cursor before hitting the DB', async () => {
    const { db, calls } = fakeDb('news_topics', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list({ cursor: 'not-a-date' })).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('rejects a future cursor at the input schema (HIGH security-reviewer #1)', async () => {
    // A caller passing `cursor=9999-12-31T00:00:00.000Z` could otherwise
    // retrieve any future-dated `is_drop=true` row before its drop_at
    // arrives. The handler also Math.min-clamps as defense in depth.
    const { db, calls } = fakeDb('news_topics', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.list({ cursor: '9999-12-31T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('coerces a non-array additional_sources to []', async () => {
    const { db } = fakeDb('news_topics', {
      data: [{ ...DROP_ROW, additional_sources: 'unexpected' as unknown as [] }],
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.list();
    expect(result.topics[0]?.additionalSources).toEqual([]);
  });

  it('wraps a DB error as INTERNAL_SERVER_ERROR', async () => {
    const { db } = fakeDb('news_topics', {
      data: null,
      error: { message: 'connection reset' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
