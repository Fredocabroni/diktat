import { describe, expect, it, vi } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';
import * as supabaseModule from '../../src/supabase.js';

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

describe('battlesRouter.submitAnswer', () => {
  it('grades against question.correct_index and writes via service role', async () => {
    // Three sequential single-table fakeDb chains: battles, battle_rounds, trivia_questions.
    // The fakeDb harness expects exactly one table per builder, so we
    // build a bespoke chained client for this test.
    const battleRow = { id: BATTLE_ID, status: 'live' };
    const roundRow = {
      id: ROUND_ID,
      round_no: 0,
      payload: { questionId: QUESTION_ID },
      created_at: new Date(Date.now() - 4_000).toISOString(),
    };
    const questionRow = { correct_index: 2 };

    const tables: Record<string, unknown> = {
      battles: { data: battleRow, error: null },
      battle_rounds: { data: roundRow, error: null },
      trivia_questions: { data: questionRow, error: null },
    };

    const calls: { table: string; ops: { op: string; args: unknown[] }[] }[] = [];

    function makeBuilder(table: string): Record<string, unknown> {
      const ops: { op: string; args: unknown[] }[] = [];
      calls.push({ table, ops });
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq']) {
        builder[op] = (...args: unknown[]) => {
          ops.push({ op, args });
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(tables[table]);
      return builder;
    }

    const db = { from: (t: string) => makeBuilder(t) };

    // Stub the service-role client for the trivia_answers insert.
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    const fakeServiceFrom = (t: string) => {
      if (t !== 'trivia_answers') {
        throw new Error(`unexpected service-role table ${t}`);
      }
      return { insert: insertSpy };
    };
    const serviceRoleSpy = vi
      .spyOn(supabaseModule, 'serviceRoleClient')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ from: fakeServiceFrom } as any);

    try {
      const caller = appRouter.createCaller(makeCtx({ db }));
      const result = await caller.battles.submitAnswer({
        battleId: BATTLE_ID,
        roundId: ROUND_ID,
        chosenIndex: 2,
      });

      expect(result.correct).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(3_500);
      expect(insertSpy).toHaveBeenCalledTimes(1);
      const sent = insertSpy.mock.calls[0]![0];
      expect(sent).toMatchObject({
        battle_id: BATTLE_ID,
        round_id: ROUND_ID,
        question_id: QUESTION_ID,
        chosen_index: 2,
        correct: true,
      });
      expect(typeof sent.latency_ms).toBe('number');
    } finally {
      serviceRoleSpy.mockRestore();
    }
  });

  it('rejects with BAD_REQUEST when battle.status is not live', async () => {
    const tables: Record<string, unknown> = {
      battles: { data: { id: BATTLE_ID, status: 'settled' }, error: null },
    };
    function makeBuilder(table: string): Record<string, unknown> {
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq']) {
        builder[op] = () => builder;
      }
      builder.maybeSingle = () => Promise.resolve(tables[table]);
      return builder;
    }
    const db = { from: (t: string) => makeBuilder(t) };
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.battles.submitAnswer({
        battleId: BATTLE_ID,
        roundId: ROUND_ID,
        chosenIndex: 0,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
