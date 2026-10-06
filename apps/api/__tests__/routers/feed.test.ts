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
  // Every call now runs TWO or THREE sequenced DB terminals:
  //   step 1 — SELECT prior.after_position (H13 server-derived
  //            before_position lookup).
  //   step 2 — INSERT the row (RETURNING .select(...).maybeSingle()).
  //   step 3 — on 23505: fallback SELECT by (user_id, client_key).
  // We standardise on sequencedFakeDb for everything so the step
  // ordering is explicit and the derived-before assertions can read the
  // insert step's payload directly.

  const NEW_ROW = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    topic_id: TOPIC_ID,
    before_position: 0,
    after_position: 1,
    created_at: '2026-04-25T00:00:00.000Z',
  };

  it('H13: first shift on a topic derives before_position=0 (no prior shift)', async () => {
    const { db, calls } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: null }, // prior SELECT: no row (first vote)
      { data: NEW_ROW, error: null }, // INSERT RETURNING
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });

    expect(calls.steps).toHaveLength(2);
    // Step 1 is the prior-shift SELECT (NOT an insert).
    const priorStep = calls.steps[0]!;
    expect(priorStep.ops.map((o) => o.op)).toContain('select');
    expect(priorStep.ops.map((o) => o.op)).not.toContain('insert');
    const priorOrder = priorStep.ops.find((o) => o.op === 'order');
    expect(priorOrder?.args[0]).toBe('created_at');

    // Step 2 is the INSERT with server-derived before_position=0.
    const insertStep = calls.steps[1]!;
    const insertOp = insertStep.ops.find((o) => o.op === 'insert');
    expect(insertOp).toBeDefined();
    const payload = insertOp!.args[0] as Record<string, unknown>;
    expect(payload.before_position).toBe(0);
    expect(payload.after_position).toBe(1);

    expect(result).toEqual({
      id: NEW_ROW.id,
      topicId: NEW_ROW.topic_id,
      beforePosition: 0,
      afterPosition: 1,
      createdAt: NEW_ROW.created_at,
    });
  });

  it("H13: second shift derives before_position from the user's latest after_position", async () => {
    const prior = { after_position: 1 }; // previous shift ended at +1
    const newRow = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      topic_id: TOPIC_ID,
      before_position: 1, // SERVER-DERIVED from prior
      after_position: -1,
      created_at: '2026-04-25T00:00:05.000Z',
    };
    const { db, calls } = sequencedFakeDb('opinion_shifts', [
      { data: prior, error: null }, // prior SELECT returns prior.after=1
      { data: newRow, error: null }, // INSERT RETURNING
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: -1,
      clientKey: CLIENT_KEY_B,
    });

    // The server-derived before_position must be the prior.after_position.
    const insertStep = calls.steps[1]!;
    const payload = insertStep.ops.find((o) => o.op === 'insert')!.args[0] as Record<
      string,
      unknown
    >;
    expect(payload.before_position).toBe(1);
    expect(payload.after_position).toBe(-1);

    expect(result).toEqual({
      id: newRow.id,
      topicId: newRow.topic_id,
      beforePosition: 1,
      afterPosition: -1,
      createdAt: newRow.created_at,
    });
  });

  it('H13: input schema no longer accepts beforePosition', async () => {
    // The caller may try to spoof a "strong flip" by sending
    // beforePosition. Zod drops unknown keys (passthrough is off),
    // so the field is silently ignored — but TypeScript rejects it at
    // the type level in the caller. Smoke-test the server flow still
    // works when the field is absent.
    const { db } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: null },
      { data: NEW_ROW, error: null },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).resolves.toMatchObject({ beforePosition: 0 });
  });

  it('maps a 23503 fk_violation to NOT_FOUND', async () => {
    const { db } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: null }, // prior SELECT: no row
      { data: null, error: { code: '23503', message: 'fk violation' } },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
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
        afterPosition: 0,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('accepts a request with NO clientKey — legacy path for stale PWA clients (H11 B2 fix-up)', async () => {
    const { db, calls } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: null },
      { data: NEW_ROW, error: null },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      // clientKey omitted — legacy path
    });

    expect(result).toEqual({
      id: NEW_ROW.id,
      topicId: NEW_ROW.topic_id,
      beforePosition: 0,
      afterPosition: 1,
      createdAt: NEW_ROW.created_at,
    });
    // Confirm the insert did NOT carry a client_key field — the payload
    // matches the pre-B2 shape byte-for-byte.
    const insertStep = calls.steps[1]!;
    const payload = insertStep.ops.find((o) => o.op === 'insert')!.args[0] as Record<
      string,
      unknown
    >;
    expect('client_key' in payload).toBe(false);
  });

  it('rejects a present-but-non-uuid clientKey at the input schema (H11 B2)', async () => {
    const { db, calls } = fakeDb('opinion_shifts', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('H13 + H11 B2: retry with same clientKey returns the ORIGINAL row unchanged (no reclassification of before_position)', async () => {
    // Scenario: user tapped Agree earlier (clientKey=K, write succeeded,
    // row persisted with before=0, after=1). Then the user changed their
    // mind to Disagree (that write succeeded with a NEW clientKey, after=-1).
    // Now the ORIGINAL tap's response was lost on the network and the
    // client retries with the ORIGINAL clientKey K.
    //
    // Freshly derived before_position would now = -1 (the user's latest
    // after). But the retry MUST return the row as it was originally
    // written, unchanged — otherwise the response would silently
    // reclassify the row's before_position depending on when the retry
    // arrived.
    const existingRow = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      topic_id: TOPIC_ID,
      before_position: 0, // ← what was written originally
      after_position: 1,
      created_at: '2026-04-25T00:00:00.000Z',
    };
    const { db, calls } = sequencedFakeDb('opinion_shifts', [
      // step 1 — prior SELECT returns the LATEST row (the mind-change),
      // which would derive before=-1 if we trusted it. The idempotency
      // path must ignore this derivation and return the EXISTING row's
      // before=0 instead.
      { data: { after_position: -1 }, error: null },
      // step 2 — INSERT returns 23505 (clientKey already used).
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      // step 3 — fallback SELECT by (user_id, client_key) returns the
      // original row (before=0, after=1).
      { data: existingRow, error: null },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });

    // THREE steps: prior SELECT → INSERT (23505) → fallback SELECT.
    expect(calls.steps).toHaveLength(3);

    // Step 3 (fallback) filtered on BOTH user_id AND client_key.
    const lookupStep = calls.steps[2]!;
    const eqCols = lookupStep.ops.filter((o) => o.op === 'eq').map((o) => o.args[0]);
    expect(eqCols).toContain('user_id');
    expect(eqCols).toContain('client_key');

    // Response is the ORIGINAL row verbatim. before_position stays 0,
    // not the -1 the prior-SELECT would have suggested.
    expect(result).toEqual({
      id: existingRow.id,
      topicId: existingRow.topic_id,
      beforePosition: 0,
      afterPosition: 1,
      createdAt: existingRow.created_at,
    });
  });

  it('on 23505 but self-scoped lookup returns nothing, throws INTERNAL_SERVER_ERROR — never fabricates a row (H11 B2)', async () => {
    const { db } = sequencedFakeDb('opinion_shifts', [
      { data: null, error: null }, // prior SELECT
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      { data: null, error: null }, // impossible-in-practice: 23505 but no row we can read.
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('same user + same topic + two different clientKeys → two rows (change-of-mind preserved) (H11 B2)', async () => {
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
      before_position: 1, // derived from rowA.after_position
      after_position: -1,
      created_at: '2026-04-25T00:00:05.000Z',
    };

    const dbA = sequencedFakeDb('opinion_shifts', [
      { data: null, error: null }, // first vote, no prior
      { data: rowA, error: null },
    ]).db;
    const dbB = sequencedFakeDb('opinion_shifts', [
      { data: { after_position: 1 }, error: null }, // mind-change, prior=rowA
      { data: rowB, error: null },
    ]).db;

    const first = await appRouter.createCaller(makeCtx({ db: dbA })).feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });
    const second = await appRouter.createCaller(makeCtx({ db: dbB })).feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: -1,
      clientKey: CLIENT_KEY_B,
    });

    expect(first.id).toBe(rowA.id);
    expect(second.id).toBe(rowB.id);
    expect(first.beforePosition).toBe(0);
    expect(second.beforePosition).toBe(1); // ← proves H13 derivation ran
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
