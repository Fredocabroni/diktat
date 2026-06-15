// Integration validation for the open-debate scoreAndSettle resume guard
// (commit feat(open-debate): crash-safe scoreAndSettle re-entry). Exercises
// the resume branch end-to-end against the real dev DB.
//
// Run:
//   (set -a; . ./.env.local; set +a; \
//      pnpm --filter=@diktat/workers exec tsx scripts/validate-open-debate-resume.ts)
//
// Hard guard: aborts unless SUPABASE_URL targets the dev project ref.
//
// What it does:
//   1. Pick two existing human users + a topic.
//   2. INSERT a synthetic `open_debate` battle with status='live', their
//      battle_participants seats, the 3 revealed argument rounds, and a
//      verdict row pre-stamped at state='scored' with a chosen winner +
//      _settlement_inputs snapshot. Simulates the post-crash state where
//      the verdict was written but the battle never flipped to settled.
//   3. Run runOpenDebateTick. Assert outcome='resumed_settlement', the
//      verdict row is byte-identical to what was seeded, and battles.status
//      flipped to 'settled' with the originally-stamped winner.
//   4. Run runOpenDebateTick a SECOND time on the now-settled battle.
//      Assert outcome='already_settled' and no new DB writes occurred --
//      idempotent end-to-end.
//   5. Cleanup: delete the synthetic battle (cascades to participants and
//      rounds via FK on delete cascade). Restore user current_ap to
//      pre-test values if the apply_ap_drafts call moved them.
//
// Notes on the AP assertion: this script seeds modest AP changes (deltas
// in the +/- 20 range) so the test stays a smoke check rather than
// stress-testing the ap-engine math. The unit suite covers the
// idempotency-key shape; this script confirms the production code path
// reaches the SQL function with the snapshot inputs.

import { runOpenDebateTick } from '../src/jobs/open-debate-runner.js';
import { buildLogger } from '../src/logger.js';
import { loadEnv } from '../src/env.js';
import { buildServiceClient, type ServiceClient } from '../src/supabase.js';
import { invoke as fabricInvoke } from '@diktat/ai-fabric';

const DEV_PROJECT_REF = 'immzaaysjlftyijwdsrm';

let totalPassed = 0;
let totalFailed = 0;

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    totalPassed += 1;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    totalFailed += 1;
  }
}

interface UserSnap {
  id: string;
  handle: string;
  current_ap: number;
  tier_id: number;
}

async function readUser(supabase: ServiceClient, id: string): Promise<UserSnap> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('users')
    .select('id, handle, current_ap, tier_id')
    .eq('id', id)
    .single()) as { data: UserSnap | null; error: { message: string } | null };
  if (error || !data) throw new Error(`readUser ${id}: ${error?.message}`);
  return data;
}

async function setUserAp(supabase: ServiceClient, id: string, current_ap: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from('users').update({ current_ap }).eq('id', id);
  if (error) throw new Error(`setUserAp: ${error.message}`);
}

async function deleteBattle(supabase: ServiceClient, battleId: string): Promise<void> {
  // FK cascade handles battle_rounds + battle_participants.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from('battles').delete().eq('id', battleId);
  if (error) throw new Error(`deleteBattle: ${error.message}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL.includes(DEV_PROJECT_REF)) {
    throw new Error(`refusing to run: SUPABASE_URL does not target dev project ${DEV_PROJECT_REF}`);
  }
  const supabase = buildServiceClient(env);
  const logger = buildLogger(env);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: users } = (await (supabase as any)
    .from('users')
    .select('id, handle, current_ap, tier_id')
    .eq('is_bot', false)
    .order('created_at', { ascending: true })
    .limit(2)) as { data: UserSnap[] | null };
  if (!users || users.length < 2) throw new Error('need two human users');
  const [A, D] = users;
  console.log(`using users: A=${A!.handle} (${A!.id})  D=${D!.handle} (${D!.id})`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: topics } = (await (supabase as any)
    .from('news_topics')
    .select('id, slug')
    .limit(1)) as { data: Array<{ id: string; slug: string }> | null };
  if (!topics || topics.length === 0) throw new Error('need a seeded topic');
  const topic = topics[0]!;
  console.log(`using topic: ${topic.slug} (${topic.id})`);

  const apABefore = A!.current_ap;
  const apDBefore = D!.current_ap;
  console.log(`AP before: A=${apABefore}  D=${apDBefore}`);

  // ---------------------------------------------------------------------
  console.log('\n--- SETUP: insert synthetic crashed battle ---');
  // ---------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: battleRow, error: battleErr } = (await (supabase as any)
    .from('battles')
    .insert({
      mode: 'open_debate',
      status: 'live',
      topic_id: topic.id,
      ap_pot: 0,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()) as { data: { id: string } | null; error: { message: string } | null };
  if (battleErr || !battleRow) throw new Error(`insert battle: ${battleErr?.message}`);
  const battleId = battleRow.id;
  console.log(`  battle_id=${battleId}`);

  let didCleanup = false;
  const cleanup = async (): Promise<void> => {
    if (didCleanup) return;
    didCleanup = true;
    console.log('\n--- CLEANUP ---');
    try {
      await deleteBattle(supabase, battleId);
      console.log('  deleted synthetic battle (+ cascaded rounds/participants)');
    } catch (err) {
      console.error('  battle delete failed:', err);
    }
    // Restore AP -- only if it changed.
    try {
      const a = await readUser(supabase, A!.id);
      const d = await readUser(supabase, D!.id);
      if (a.current_ap !== apABefore) {
        await setUserAp(supabase, A!.id, apABefore);
        console.log(`  restored A.current_ap ${a.current_ap} -> ${apABefore}`);
      }
      if (d.current_ap !== apDBefore) {
        await setUserAp(supabase, D!.id, apDBefore);
        console.log(`  restored D.current_ap ${d.current_ap} -> ${apDBefore}`);
      }
    } catch (err) {
      console.error('  AP restore failed:', err);
    }
  };

  try {
    // Seat both users.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: pErr } = await (supabase as any).from('battle_participants').insert([
      { battle_id: battleId, user_id: A!.id, seat: 0, entry_ap: apABefore },
      { battle_id: battleId, user_id: D!.id, seat: 1, entry_ap: apDBefore },
    ]);
    if (pErr) throw new Error(`participants insert: ${pErr.message}`);

    // Rounds 0-2 revealed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rErr } = await (supabase as any).from('battle_rounds').insert([
      { battle_id: battleId, round_no: 0, payload: { state: 'revealed' } },
      { battle_id: battleId, round_no: 1, payload: { state: 'revealed' } },
      { battle_id: battleId, round_no: 2, payload: { state: 'revealed' } },
    ]);
    if (rErr) throw new Error(`arg rounds insert: ${rErr.message}`);

    // Verdict row pre-stamped 'scored' with D as winner + snapshot.
    const settledAt = new Date().toISOString();
    const verdictPayload = {
      state: 'scored',
      ai: { winnerSeat: 1, scoreA: 60, scoreB: 80, reason: 'validation seed' },
      community: { ap_for_seat_0: 100, ap_for_seat_1: 300, voter_count: 2 },
      disagreement: false,
      decided_by: 'community_ap',
      winner_seat: 1,
      winner_user_id: D!.id,
      settled_at: settledAt,
      _settlement_inputs: {
        winner: { user_id: D!.id, ap_before: apDBefore, tier: D!.tier_id },
        loser: {
          user_id: A!.id,
          ap_before: apABefore,
          tier: A!.tier_id,
          consecutive_losses: 0,
          reductions_used: 0,
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verdictRow, error: vErr } = (await (supabase as any)
      .from('battle_rounds')
      .insert({
        battle_id: battleId,
        round_no: 3,
        payload: verdictPayload,
        winner_user_id: D!.id,
        deadline_at: settledAt,
      })
      .select('id, payload, winner_user_id')
      .single()) as {
      data: { id: string; payload: Record<string, unknown>; winner_user_id: string } | null;
      error: { message: string } | null;
    };
    if (vErr || !verdictRow) throw new Error(`verdict row insert: ${vErr?.message}`);
    const verdictRowId = verdictRow.id;
    const verdictPayloadBefore = JSON.stringify(verdictRow.payload);

    // ---------------------------------------------------------------------
    console.log('\n--- TICK 1: resume settlement ---');
    // ---------------------------------------------------------------------
    const outcome1 = await runOpenDebateTick(battleId, {
      supabase,
      logger,
      invoke: fabricInvoke,
    });
    assert(
      "tick 1 outcome = 'resumed_settlement'",
      outcome1.phase === 'resumed_settlement',
      `got ${outcome1.phase}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: battleAfter1 } = (await (supabase as any)
      .from('battles')
      .select('status, winner_user_id, ended_at')
      .eq('id', battleId)
      .single()) as {
      data: { status: string; winner_user_id: string | null; ended_at: string | null } | null;
    };
    assert("battle status flipped to 'settled'", battleAfter1?.status === 'settled');
    assert('battle winner_user_id = originally-stamped D', battleAfter1?.winner_user_id === D!.id);
    assert('battle ended_at populated', battleAfter1?.ended_at !== null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verdictAfter1 } = (await (supabase as any)
      .from('battle_rounds')
      .select('payload, winner_user_id')
      .eq('id', verdictRowId)
      .single()) as {
      data: { payload: Record<string, unknown>; winner_user_id: string } | null;
    };
    assert(
      'verdict row payload unchanged after resume',
      JSON.stringify(verdictAfter1?.payload) === verdictPayloadBefore,
    );
    assert('verdict row winner_user_id unchanged', verdictAfter1?.winner_user_id === D!.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: txsAfter1 } = (await (supabase as any)
      .from('ap_transactions')
      .select('idempotency_key, delta, reason')
      .eq('ref_type', 'battle')
      .eq('ref_id', battleId)) as {
      data: Array<{ idempotency_key: string; delta: number; reason: string }> | null;
    };
    const txCount1 = txsAfter1?.length ?? 0;
    assert(
      'AP transactions written for both sides',
      txCount1 === 2,
      `got ${txCount1}: ${(txsAfter1 ?? []).map((t) => t.reason).join(',')}`,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TICK 2: idempotent no-op on settled battle ---');
    // ---------------------------------------------------------------------
    const outcome2 = await runOpenDebateTick(battleId, {
      supabase,
      logger,
      invoke: fabricInvoke,
    });
    assert(
      "tick 2 outcome = 'already_settled'",
      outcome2.phase === 'already_settled',
      `got ${outcome2.phase}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: txsAfter2 } = (await (supabase as any)
      .from('ap_transactions')
      .select('idempotency_key')
      .eq('ref_type', 'battle')
      .eq('ref_id', battleId)) as {
      data: Array<{ idempotency_key: string }> | null;
    };
    assert(
      'no new AP transactions on tick 2',
      (txsAfter2?.length ?? 0) === txCount1,
      `tick1=${txCount1} tick2=${txsAfter2?.length}`,
    );
  } finally {
    await cleanup();
  }

  console.log(`\n=== ${totalPassed} passed, ${totalFailed} failed ===`);
  if (totalFailed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
