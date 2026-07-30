import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { makeCtx } from '../helpers.js';

/**
 * `castVote` now delegates entirely to the SECURITY DEFINER `cast_debate_vote`
 * RPC (#114, migration 20260730120000): the RPC snapshots ap_at_vote_time from
 * users.current_ap server-side (unforgeable) and enforces round/deadline/
 * participation atomically. So the router is a thin wrapper — it must call
 * `.rpc()` and touch no tables directly. These tests pin (a) delegation + arg
 * passing, (b) the narrow { ok, voteId } response (no AP oracle), and (c) the
 * SQLSTATE → TRPCError mapping. The AP-snapshot correctness itself is proven at
 * the DB layer in supabase/tests/sql/cast_debate_vote.test.sql.
 */
function rpcDb(result: { data: unknown; error: { code?: string; message: string } | null }): {
  db: Context['db'];
  calls: { fn: string; args: unknown }[];
} {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    // The wrapper must not read/write tables directly anymore.
    from: (table: string) => {
      throw new Error(`rpcDb: unexpected from("${table}") — castVote must go through rpc()`);
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  };
  return { db: db as unknown as Context['db'], calls };
}

const BATTLE_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_A_ID = '22222222-2222-4222-8222-222222222222';
const VOTE_ROW_ID = '44444444-4444-4444-8444-444444444444';

describe('debatesRouter.castVote — delegates to cast_debate_vote RPC', () => {
  it('calls the RPC with the mapped args and returns exactly { ok, voteId }', async () => {
    const { db, calls } = rpcDb({ data: VOTE_ROW_ID, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.debates.castVote({
      battleId: BATTLE_ID,
      voteForUserId: PARTICIPANT_A_ID,
    });

    // Delegation: exactly one rpc call, correct fn + args (voter derived from
    // auth.uid() inside the RPC — never passed from the client).
    expect(calls).toEqual([
      {
        fn: 'cast_debate_vote',
        args: { p_battle_id: BATTLE_ID, p_vote_for_user_id: PARTICIPANT_A_ID },
      },
    ]);

    // Narrow response — no authoritative-AP echo (MEDIUM-2 disclosure guard).
    // The RPC never returns AP, so the oracle is structurally impossible now.
    expect(result).toEqual({ ok: true, voteId: VOTE_ROW_ID });
    expect(Object.keys(result).sort()).toEqual(['ok', 'voteId']);
    expect(result).not.toHaveProperty('apWeight');
    expect(result).not.toHaveProperty('current_ap');
  });

  it.each([
    ['DK003', 'BAD_REQUEST'],
    ['DK004', 'BAD_REQUEST'],
    ['DK001', 'FORBIDDEN'],
    ['DK002', 'BAD_REQUEST'],
    ['23505', 'CONFLICT'],
    ['P0002', 'INTERNAL_SERVER_ERROR'],
    ['XX000', 'INTERNAL_SERVER_ERROR'],
  ])('maps RPC SQLSTATE %s → TRPCError %s', async (code, trpcCode) => {
    const { db } = rpcDb({ data: null, error: { code, message: `db error ${code}` } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.debates.castVote({ battleId: BATTLE_ID, voteForUserId: PARTICIPANT_A_ID }),
    ).rejects.toMatchObject({ code: trpcCode });
  });
});
