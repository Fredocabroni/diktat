import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx, type FakeQueryResult } from '../helpers.js';

const TOPIC_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_KEY_A = 'cccccccc-1111-4111-8111-cccccccccccc';
const CLIENT_KEY_B = 'cccccccc-2222-4222-8222-cccccccccccc';

// H11 B2: a fakeDb that returns a sequence of results per terminal
// .maybeSingle() call, so the handler's two-step 23505 + SELECT-fallback
// path can be exercised in one caller invocation. Rebuilt locally
// because the shared fakeDb only supports one canned response.
type Result = FakeQueryResult<Record<string, unknown>>;
function sequencedFakeDb(table: string, results: Result[]) {
  const calls: {
    table: string;
    steps: Array<{ ops: { op: string; args: unknown[] }[]; result: Result }>;
  } = { table, steps: [] };
  let cursor = 0;

  function newBuilder(): Record<string, unknown> {
    const ops: { op: string; args: unknown[] }[] = [];
    const builder: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'insert', 'upsert', 'update', 'delete', 'order', 'limit']) {
      builder[op] = (...args: unknown[]) => {
        ops.push({ op, args });
        return builder;
      };
    }
    const terminal = () => {
      const r = results[cursor] ?? { data: null, error: null };
      cursor += 1;
      calls.steps.push({ ops, result: r });
      return Promise.resolve(r);
    };
    builder.maybeSingle = terminal;
    builder.single = terminal;
    builder.then = (resolve: (v: Result) => unknown) => terminal().then(resolve);
    return builder;
  }

  const db = {
    from: (t: string) => {
      if (t !== table) throw new Error(`sequencedFakeDb: unexpected table ${t}`);
      return newBuilder();
    },
    rpc: (_fn: string) => ({
      then: (resolve: (v: { data: null; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: null, error: null })),
    }),
  };
  return { db, calls };
}

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
      clientKey: CLIENT_KEY_A,
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
        clientKey: CLIENT_KEY_A,
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
        clientKey: CLIENT_KEY_A,
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
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('accepts a request with NO clientKey — legacy path for stale PWA clients (H11 B2 fix-up)', async () => {
    // A cached PWA bundle from before B2 shipped has no clientKey field
    // in its outgoing tRPC input. That must continue to work: the row
    // is inserted with client_key = NULL, the partial unique index
    // (which excludes NULL rows) does not apply, and the response looks
    // exactly like any other successful record. Regression until the
    // rollout finishes and the field is tightened to required.
    const row = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      topic_id: TOPIC_ID,
      before_position: 0,
      after_position: 1,
      created_at: '2026-04-25T00:00:00.000Z',
    };
    const { db, calls } = fakeDb('opinion_shifts', { data: row, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      beforePosition: 0,
      afterPosition: 1,
      // clientKey omitted — legacy path
    });

    expect(result).toEqual({
      id: row.id,
      topicId: row.topic_id,
      beforePosition: 0,
      afterPosition: 1,
      createdAt: row.created_at,
    });
    // Confirm the insert did NOT carry a client_key field — the payload
    // matches the pre-B2 shape byte-for-byte.
    const insertOp = calls.ops.find((o) => o.op === 'insert');
    expect(insertOp).toBeDefined();
    const payload = insertOp!.args[0] as Record<string, unknown>;
    expect('client_key' in payload).toBe(false);
  });

  it('rejects a present-but-non-uuid clientKey at the input schema (H11 B2)', async () => {
    // If the client bothered to send the field, it must be a uuid. This
    // catches contributor-side breakage without silently dropping the
    // idempotency guarantee.
    const { db, calls } = fakeDb('opinion_shifts', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        beforePosition: 0,
        afterPosition: 1,
        clientKey: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(TRPCError);

    // Rejected at the schema layer — never hit the DB.
    expect(calls.ops).toEqual([]);
  });

  it('on 23505 unique_violation, looks up the existing row (self-scoped) and returns it — no duplicate write, no second streak credit (H11 B2)', async () => {
    const existingRow = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      topic_id: TOPIC_ID,
      before_position: 0,
      after_position: 1,
      created_at: '2026-04-25T00:00:00.000Z',
    };
    // Sequenced results: first terminal (the .insert(...).select(...).maybeSingle())
    // fires 23505; second terminal (the SELECT-by-user_id+client_key fallback)
    // returns the existing row.
    const { db, calls } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      { data: existingRow, error: null },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      beforePosition: 0,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });

    // Exactly two DB round-trips: the INSERT and the fallback SELECT.
    // NOT three (would mean a second INSERT, i.e. a second streak-trigger
    // fire — the whole thing this fix exists to prevent).
    expect(calls.steps).toHaveLength(2);
    const insertStep = calls.steps[0]!;
    const lookupStep = calls.steps[1]!;

    // Step 1: was an INSERT.
    expect(insertStep.ops.map((o) => o.op)).toContain('insert');

    // Step 2: was a SELECT filtered by BOTH user_id AND client_key
    // (per-user scoping — belt AND suspenders vs RLS).
    const lookupOps = lookupStep.ops.map((o) => o.op);
    expect(lookupOps).toContain('select');
    const eqCalls = lookupStep.ops.filter((o) => o.op === 'eq');
    const eqCols = eqCalls.map((c) => c.args[0]);
    expect(eqCols).toContain('user_id');
    expect(eqCols).toContain('client_key');
    // No second insert.
    expect(lookupOps).not.toContain('insert');

    // Response shape is identical to a fresh-write success.
    expect(result).toEqual({
      id: existingRow.id,
      topicId: existingRow.topic_id,
      beforePosition: existingRow.before_position,
      afterPosition: existingRow.after_position,
      createdAt: existingRow.created_at,
    });
  });

  it('on 23505 but self-scoped lookup returns nothing, throws INTERNAL_SERVER_ERROR — never fabricates a row (H11 B2)', async () => {
    const { db } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      { data: null, error: null }, // impossible-in-practice: 23505 but no row we can read.
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        beforePosition: 0,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('same user + same topic + two different clientKeys → two rows (change-of-mind preserved) (H11 B2)', async () => {
    // Each mutation call is independent (different clientKey → different
    // INSERT), so the fresh-row path fires twice. Use the shared fakeDb
    // per call.
    const rowA = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      topic_id: TOPIC_ID,
      before_position: 0,
      after_position: 1,
      created_at: '2026-04-25T00:00:00.000Z',
    };
    const rowB = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      topic_id: TOPIC_ID,
      before_position: 0,
      after_position: -1,
      created_at: '2026-04-25T00:00:05.000Z',
    };

    const dbA = fakeDb('opinion_shifts', { data: rowA, error: null }).db;
    const dbB = fakeDb('opinion_shifts', { data: rowB, error: null }).db;

    const first = await appRouter.createCaller(makeCtx({ db: dbA })).feed.recordShift({
      topicId: TOPIC_ID,
      beforePosition: 0,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });
    const second = await appRouter.createCaller(makeCtx({ db: dbB })).feed.recordShift({
      topicId: TOPIC_ID,
      beforePosition: 0,
      afterPosition: -1,
      clientKey: CLIENT_KEY_B,
    });

    expect(first.id).toBe(rowA.id);
    expect(second.id).toBe(rowB.id);
    expect(first.afterPosition).toBe(1);
    expect(second.afterPosition).toBe(-1);
    // Distinct rows — proves the design doesn't collapse legitimate
    // mind-changes into the idempotency path.
    expect(first.id).not.toBe(second.id);
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

    await expect(caller.feed.list({ cursor: '9999-12-31T00:00:00.000Z' })).rejects.toBeInstanceOf(
      TRPCError,
    );
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
