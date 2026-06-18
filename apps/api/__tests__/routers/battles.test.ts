import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { fakeDb, type FakeQueryResult, makeCtx } from '../helpers.js';

const BATTLE_ID = '11111111-1111-4111-8111-111111111111';
const ROUND_ID = '22222222-2222-4222-8222-222222222222';
const QUESTION_ID = '33333333-3333-4333-8333-333333333333';

describe('battlesRouter.getRound', () => {
  it('returns the next round above sinceRoundNo or null', async () => {
    const row = {
      id: ROUND_ID,
      round_no: 2,
      payload: { questionId: QUESTION_ID },
      winner_user_id: null,
      created_at: '2026-04-26T00:00:00.000Z',
    };
    const { db, calls } = fakeDb('battle_rounds', { data: row, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.battles.getRound({
      battleId: BATTLE_ID,
      sinceRoundNo: 1,
    });

    expect(result.round).toMatchObject({
      id: ROUND_ID,
      roundNo: 2,
      payload: { questionId: QUESTION_ID },
    });
    const gtCall = calls.ops.find((op) => op.op === 'gt');
    expect(gtCall?.args).toEqual(['round_no', 1]);
  });

  it('returns round=null when no row matches', async () => {
    const { db } = fakeDb('battle_rounds', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.battles.getRound({
      battleId: BATTLE_ID,
      sinceRoundNo: 5,
    });
    expect(result).toEqual({ round: null });
  });
});

// submitAnswer now routes entirely through `rpc('submit_trivia_answer')`
// — the SECURITY DEFINER function grades, validates, and inserts inside
// the DB. The router's only job is to map sqlstate → tRPC error codes.
// The fake below stubs `rpc(...)` directly + asserts the args shape.
function fakeRpcDb(opts: {
  rpc: FakeQueryResult<unknown>;
  rpcCalls?: { fn: string; args: unknown }[];
}): Context['db'] {
  const calls = opts.rpcCalls;
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'lt', 'lte', 'gt', 'gte', 'order', 'limit']) {
    builder[op] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(opts.rpc);
  builder.single = () => Promise.resolve(opts.rpc);
  builder.then = (resolve: (v: FakeQueryResult<unknown>) => unknown) =>
    Promise.resolve(resolve(opts.rpc));
  return {
    rpc: (fn: string, args?: unknown) => {
      calls?.push({ fn, args });
      return builder;
    },
    from: () => {
      throw new Error('fakeRpcDb: did not expect a from() call');
    },
  } as unknown as Context['db'];
}

describe('battlesRouter.submitAnswer', () => {
  it('forwards (battle_id, round_id, chosen_index) and returns {correct, latencyMs}', async () => {
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = fakeRpcDb({
      rpc: { data: { correct: true, latency_ms: 1234 }, error: null },
      rpcCalls,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.battles.submitAnswer({
      battleId: BATTLE_ID,
      roundId: ROUND_ID,
      chosenIndex: 2,
    });

    expect(result).toEqual({ correct: true, latencyMs: 1234 });
    expect(rpcCalls).toEqual([
      {
        fn: 'submit_trivia_answer',
        args: {
          p_battle_id: BATTLE_ID,
          p_round_id: ROUND_ID,
          p_chosen_index: 2,
        },
      },
    ]);
  });

  it('maps 23505 (re-submit) → CONFLICT', async () => {
    const db = fakeRpcDb({
      rpc: { data: null, error: { code: '23505', message: 'already answered this round' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.battles.submitAnswer({ battleId: BATTLE_ID, roundId: ROUND_ID, chosenIndex: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps 42501 (not a participant) → FORBIDDEN', async () => {
    const db = fakeRpcDb({
      rpc: { data: null, error: { code: '42501', message: 'not a participant' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.battles.submitAnswer({ battleId: BATTLE_ID, roundId: ROUND_ID, chosenIndex: 0 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps 22023 (battle not live / bad input) → BAD_REQUEST', async () => {
    const db = fakeRpcDb({
      rpc: { data: null, error: { code: '22023', message: 'battle not accepting answers' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.battles.submitAnswer({ battleId: BATTLE_ID, roundId: ROUND_ID, chosenIndex: 0 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps P0002 (battle/round/question missing) → NOT_FOUND', async () => {
    const db = fakeRpcDb({
      rpc: { data: null, error: { code: 'P0002', message: 'round not found' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.battles.submitAnswer({ battleId: BATTLE_ID, roundId: ROUND_ID, chosenIndex: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps 28000 (unauthenticated) → UNAUTHORIZED', async () => {
    const db = fakeRpcDb({
      rpc: { data: null, error: { code: '28000', message: 'unauthenticated' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.battles.submitAnswer({ battleId: BATTLE_ID, roundId: ROUND_ID, chosenIndex: 0 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('unmapped sqlstate falls through to INTERNAL_SERVER_ERROR', async () => {
    const db = fakeRpcDb({
      rpc: { data: null, error: { code: 'XX000', message: 'something else' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.battles.submitAnswer({ battleId: BATTLE_ID, roundId: ROUND_ID, chosenIndex: 0 }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
