import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';

const USER_ID = 'user-123';
const TOPIC_A = '11111111-1111-1111-1111-111111111111';
const TOPIC_B = '22222222-2222-2222-2222-222222222222';
const TOPIC_C = '33333333-3333-3333-3333-333333333333';
const CLIENT_KEY = 'cccccccc-1111-4111-8111-cccccccccccc';

// ---------------------------------------------------------------------------
// getStack
// ---------------------------------------------------------------------------

function stackFake(opts: {
  readonly topics: Array<{ id: string; drop_at: string }>;
  readonly stancedTopicIds: string[];
  readonly topicErr?: { message: string } | null;
  readonly stanceErr?: { message: string } | null;
}): {
  db: { from: unknown; rpc: unknown };
  fromCalls: Array<{ table: string; ops: Array<{ op: string; args: unknown[] }> }>;
} {
  const fromCalls: Array<{
    table: string;
    ops: Array<{ op: string; args: unknown[] }>;
  }> = [];
  const from = (t: string) => {
    const ops: Array<{ op: string; args: unknown[] }> = [];
    fromCalls.push({ table: t, ops });
    const builder: Record<string, unknown> = {};
    const chain =
      (op: string) =>
      (...args: unknown[]) => {
        ops.push({ op, args });
        return builder;
      };
    for (const op of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) {
      builder[op] = chain(op);
    }
    const terminal = () => {
      if (t === 'news_topics') {
        return Promise.resolve({
          data: opts.topicErr
            ? null
            : opts.topics.map((row) => ({
                id: row.id,
                headline: 'h',
                source_title: 's',
                summary: 'sum',
                primary_source_url: 'https://example.com/',
                category: 'cat',
                drop_at: row.drop_at,
                dedup_cluster_id: 'c',
                additional_sources: null,
                fact_explainer: null,
              })),
          error: opts.topicErr ?? null,
        });
      }
      if (t === 'opinion_shifts') {
        return Promise.resolve({
          data: opts.stanceErr ? null : opts.stancedTopicIds.map((id) => ({ topic_id: id })),
          error: opts.stanceErr ?? null,
        });
      }
      throw new Error(`stackFake: unexpected table "${t}"`);
    };
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(terminal()));
    return builder;
  };
  const rpc = () => {
    throw new Error('stackFake: unexpected rpc()');
  };
  return { db: { from, rpc }, fromCalls };
}

describe('take5Router.getStack', () => {
  it('returns up to 5 unstanced Drops newest-first', async () => {
    const topics = [
      // Oldest first in the fixture; the fake preserves order so the
      // router's `.order('drop_at', { ascending: false })` is a no-op
      // against our list. We encode the newest first here directly.
      { id: TOPIC_A, drop_at: '2026-10-20T00:00:00Z' },
      { id: TOPIC_B, drop_at: '2026-10-19T00:00:00Z' },
      { id: TOPIC_C, drop_at: '2026-10-18T00:00:00Z' },
    ];
    const { db, fromCalls } = stackFake({ topics, stancedTopicIds: [] });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const r = await caller.take5.getStack();
    expect(r.cards.map((c) => c.id)).toEqual([TOPIC_A, TOPIC_B, TOPIC_C]);

    // The second query must be the opinion_shifts stance lookup
    // scoped to the caller's user_id — not some other user.
    const shiftCall = fromCalls.find((c) => c.table === 'opinion_shifts');
    expect(shiftCall).toBeDefined();
    const eqOps = shiftCall!.ops.filter((o) => o.op === 'eq');
    expect(eqOps.some((o) => o.args[0] === 'user_id' && o.args[1] === USER_ID)).toBe(true);
  });

  it('excludes topics the caller has already stanced on', async () => {
    const topics = [
      { id: TOPIC_A, drop_at: '2026-10-20T00:00:00Z' },
      { id: TOPIC_B, drop_at: '2026-10-19T00:00:00Z' },
      { id: TOPIC_C, drop_at: '2026-10-18T00:00:00Z' },
    ];
    const { db } = stackFake({ topics, stancedTopicIds: [TOPIC_B] });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const r = await caller.take5.getStack();
    expect(r.cards.map((c) => c.id)).toEqual([TOPIC_A, TOPIC_C]);
  });

  it('caps the returned stack at 5 even when more unstanced Drops are in the window', async () => {
    const topics = Array.from({ length: 10 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, '0')}`,
      drop_at: `2026-10-${20 - i}T00:00:00Z`,
    }));
    const { db } = stackFake({ topics, stancedTopicIds: [] });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const r = await caller.take5.getStack();
    expect(r.cards).toHaveLength(5);
  });

  it('returns an empty stack when news_topics returns zero rows (thin archive)', async () => {
    const { db } = stackFake({ topics: [], stancedTopicIds: [] });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const r = await caller.take5.getStack();
    expect(r.cards).toEqual([]);
  });

  it('throws when the stance lookup fails — never returns potentially-stanced cards', async () => {
    const topics = [{ id: TOPIC_A, drop_at: '2026-10-20T00:00:00Z' }];
    const { db } = stackFake({
      topics,
      stancedTopicIds: [],
      stanceErr: { message: 'boom' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(caller.take5.getStack()).rejects.toBeInstanceOf(TRPCError);
  });

  it('throws when the topic lookup fails', async () => {
    const { db } = stackFake({
      topics: [],
      stancedTopicIds: [],
      topicErr: { message: 'boom' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(caller.take5.getStack()).rejects.toBeInstanceOf(TRPCError);
  });
});

// ---------------------------------------------------------------------------
// recordShift — RPC delegation + sqlstate mapping
// ---------------------------------------------------------------------------

type RpcResult = {
  data: Array<Record<string, unknown>> | Record<string, unknown> | null;
  error: { code?: string; message?: string } | null;
};
interface RpcCall {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}
function rpcFake(results: RpcResult[]): { db: { rpc: unknown; from: unknown }; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let cursor = 0;
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const r = results[cursor] ?? { data: null, error: null };
    cursor += 1;
    return Promise.resolve(r);
  };
  const from = (t: string) => {
    throw new Error(`rpcFake: unexpected .from('${t}') — recordShift must only call .rpc()`);
  };
  return { db: { rpc, from }, calls };
}

describe('take5Router.recordShift', () => {
  const RPC_ROW = {
    shift_id: 'ffffffff-aaaa-aaaa-aaaa-ffffffffffff',
    topic_id: TOPIC_A,
    et_day: '2026-10-19',
    cards_today: 1,
  };

  it('calls record_take5_shift with the input topic / after_position / client_key', async () => {
    const { db, calls } = rpcFake([{ data: [RPC_ROW], error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    const r = await caller.take5.recordShift({
      topicId: TOPIC_A,
      afterPosition: 1,
      clientKey: CLIENT_KEY,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('record_take5_shift');
    expect(calls[0]!.args).toEqual({
      p_topic_id: TOPIC_A,
      p_after_position: 1,
      p_client_key: CLIENT_KEY,
    });
    expect(r).toEqual({
      shiftId: RPC_ROW.shift_id,
      topicId: RPC_ROW.topic_id,
      etDay: RPC_ROW.et_day,
      cardsToday: 1,
    });
  });

  it('also accepts a single-object .data (non-setof shape) from supabase-js', async () => {
    const { db } = rpcFake([{ data: RPC_ROW, error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    const r = await caller.take5.recordShift({
      topicId: TOPIC_A,
      afterPosition: 1,
      clientKey: CLIENT_KEY,
    });
    expect(r.shiftId).toBe(RPC_ROW.shift_id);
  });

  it('omits p_client_key when the input omits clientKey (legacy PWA path)', async () => {
    const { db, calls } = rpcFake([{ data: [RPC_ROW], error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 });
    expect(calls[0]!.args).toEqual({
      p_topic_id: TOPIC_A,
      p_after_position: 1,
      p_client_key: undefined,
    });
  });

  it('maps RPC sqlstate 54000 → TOO_MANY_REQUESTS (daily cap)', async () => {
    const { db } = rpcFake([{ data: null, error: { code: '54000', message: 'cap' } }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('maps sqlstate P0002 → NOT_FOUND (topic missing)', async () => {
    const { db } = rpcFake([{ data: null, error: { code: 'P0002', message: 'nope' } }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps sqlstate 22023 → BAD_REQUEST (invalid position)', async () => {
    const { db } = rpcFake([{ data: null, error: { code: '22023', message: 'range' } }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps sqlstate 28000 → UNAUTHORIZED (defence in depth)', async () => {
    const { db } = rpcFake([{ data: null, error: { code: '28000', message: 'no sub' } }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('maps unknown error codes → INTERNAL_SERVER_ERROR', async () => {
    const { db } = rpcFake([{ data: null, error: { code: 'XX000', message: 'who' } }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('throws INTERNAL_SERVER_ERROR when the RPC returns null data without an error', async () => {
    const { db } = rpcFake([{ data: null, error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 1 }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('rejects a non-UUID topic id at the input schema', async () => {
    const { db } = rpcFake([]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: 'nope', afterPosition: 1 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('rejects out-of-range afterPosition at the input schema', async () => {
    const { db } = rpcFake([]);
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.take5.recordShift({ topicId: TOPIC_A, afterPosition: 99 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

// Keep lint happy about the imported constant.
void USER_ID;
