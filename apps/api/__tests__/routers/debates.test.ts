import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { makeCtx } from '../helpers.js';

/**
 * Debates router multi-table + ordered fake. `castVote` reads four
 * tables in sequence (battle_rounds, battle_participants, users,
 * debate_votes) so the stubbed responses are keyed by table name —
 * each table is touched at most once per call. Same shape as the
 * wallet-router multiTableDb helper.
 */
function multiTableDb(
  responses: Record<string, { data: unknown; error: { code?: string; message: string } | null }>,
): {
  db: Context['db'];
  calls: { table: string; ops: { op: string; args: unknown[] }[] }[];
} {
  const calls: { table: string; ops: { op: string; args: unknown[] }[] }[] = [];

  const makeBuilder = (table: string, result: { data: unknown; error: unknown }) => {
    const ops: { op: string; args: unknown[] }[] = [];
    calls.push({ table, ops });
    const builder: Record<string, unknown> = {};
    for (const op of [
      'select',
      'eq',
      'lt',
      'gt',
      'or',
      'order',
      'limit',
      'update',
      'insert',
      'upsert',
      'delete',
    ]) {
      builder[op] = (...args: unknown[]) => {
        ops.push({ op, args });
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(result);
    builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result));
    return builder;
  };

  const db = {
    from: (table: string) => {
      const r = responses[table];
      if (!r) throw new Error(`multiTableDb: no response stubbed for "${table}"`);
      return makeBuilder(table, r);
    },
    // castVote never calls .rpc(); guard with a thrower so a future
    // refactor that adds one fails loudly here.
    rpc: (fn: string) => {
      throw new Error(`multiTableDb: unexpected rpc call "${fn}"`);
    },
  };

  return { db: db as unknown as Context['db'], calls };
}

const BATTLE_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_A_ID = '22222222-2222-4222-8222-222222222222';
const PARTICIPANT_B_ID = '33333333-3333-4333-8333-333333333333';
const VOTE_ROW_ID = '44444444-4444-4444-8444-444444444444';

function happyPathDb(): ReturnType<typeof multiTableDb> {
  // Verdict round in awaiting_final_vote with a deadline well in the
  // future. PARTICIPANT_A / PARTICIPANT_B are seated; the test caller
  // (user-123 from makeCtx) is the non-participant voter.
  return multiTableDb({
    battle_rounds: {
      data: {
        id: 'round-verdict-id',
        payload: { state: 'awaiting_final_vote' },
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    },
    battle_participants: {
      data: [{ user_id: PARTICIPANT_A_ID }, { user_id: PARTICIPANT_B_ID }],
      error: null,
    },
    users: {
      data: { current_ap: 4250 },
      error: null,
    },
    debate_votes: {
      data: { id: VOTE_ROW_ID },
      error: null,
    },
  });
}

// ---------------------------------------------------------------------------
// MEDIUM-2 disclosure-pass regression guard.
//
// `castVote` previously returned the caller's authoritative `current_ap`
// in the mutation response (`apWeight: voterRow.current_ap`). No UI
// consumer read the field; it acted as an oracle a stale client could
// use to refresh its cached AP from the server on every vote. Stripped
// in PR #62 round-3 disclosure pass — the tests below pin that the
// response stays narrow ({ ok, voteId }) so a future refactor cannot
// quietly re-introduce the leak.
//
// The DB-write path is unchanged: `voterRow.current_ap` is still
// snapshot into `debate_votes.ap_at_vote_time` so weight calculations
// remain authoritative. We assert that path is intact by inspecting
// the `insert()` call args, not by checking the return shape.
// ---------------------------------------------------------------------------
describe('debatesRouter.castVote — MEDIUM-2 disclosure pass regression', () => {
  it('returns exactly { ok, voteId } — no apWeight or other authoritative-AP echo', async () => {
    const { db } = happyPathDb();
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.debates.castVote({
      battleId: BATTLE_ID,
      voteForUserId: PARTICIPANT_A_ID,
    });

    // Exact-shape assertion: any field beyond ok+voteId trips this.
    expect(result).toEqual({ ok: true, voteId: VOTE_ROW_ID });
    expect(Object.keys(result).sort()).toEqual(['ok', 'voteId']);

    // Belt-and-suspenders: explicitly assert apWeight is structurally
    // absent. If a future refactor adds it back, this fails loud.
    expect(result).not.toHaveProperty('apWeight');
    expect(result).not.toHaveProperty('current_ap');
    expect(result).not.toHaveProperty('currentAp');
  });

  it('still writes voterRow.current_ap into debate_votes.ap_at_vote_time (DB path preserved)', async () => {
    const { db, calls } = happyPathDb();
    const caller = appRouter.createCaller(makeCtx({ db }));

    await caller.debates.castVote({
      battleId: BATTLE_ID,
      voteForUserId: PARTICIPANT_A_ID,
    });

    // Find the debate_votes table call, then the insert() op on it.
    const voteCall = calls.find((c) => c.table === 'debate_votes');
    expect(voteCall).toBeDefined();
    const insertOp = voteCall?.ops.find((o) => o.op === 'insert');
    expect(insertOp).toBeDefined();
    const insertedRow = insertOp?.args[0] as {
      battle_id: string;
      voter_user_id: string;
      vote_for_user_id: string;
      ap_at_vote_time: number;
    };
    // The authoritative snapshot is on the row that goes into the DB,
    // not on the wire — that's the contract this regression guards.
    expect(insertedRow.ap_at_vote_time).toBe(4250);
    expect(insertedRow.battle_id).toBe(BATTLE_ID);
    expect(insertedRow.vote_for_user_id).toBe(PARTICIPANT_A_ID);
  });
});
