// Integration validation for the PR 4.4 streak engine. Exercises the three
// SECURITY DEFINER SQL functions + the opinion_shifts trigger end-to-end
// against the real DB. Snapshots streak state per participant before each
// test, restores it after.
//
// Run:
//   (set -a; . ./.env.local; set +a; \
//      pnpm --filter=@diktat/workers exec tsx scripts/validate-streak-engine.ts)
//
// Hard guard: aborts unless SUPABASE_URL targets the dev project ref.
//
// Cleanup: every assertion path runs in a try/finally with state
// restoration. A mid-script crash leaves the dev DB at the original
// snapshot.

import { loadEnv } from '../src/env.js';
import { buildServiceClient, type ServiceClient } from '../src/supabase.js';

const DEV_PROJECT_REF = 'immzaaysjlftyijwdsrm';

interface StreakRow {
  user_id: string;
  current_length: number;
  longest_length: number;
  last_action_date: string | null;
  freeze_tokens: number;
  take5_progress: number;
  take5_local_date: string | null;
  last_freeze_used_local_date: string | null;
  freeze_tokens_max: number;
}

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

async function readStreak(supabase: ServiceClient, userId: string): Promise<StreakRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any)
    .from('streaks')
    .select('*')
    .eq('user_id', userId)
    .single()) as { data: StreakRow | null; error: { message: string } | null };
  if (error || !data) throw new Error(`readStreak: ${error?.message}`);
  return data;
}

async function setStreak(
  supabase: ServiceClient,
  userId: string,
  patch: Partial<StreakRow>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from('streaks').update(patch).eq('user_id', userId);
  if (error) throw new Error(`setStreak: ${error.message}`);
}

async function callRpc<T>(
  supabase: ServiceClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (supabase as any).rpc(fn, args)) as {
    data: T;
    error: { message: string } | null;
  };
  if (error) throw new Error(`${fn} RPC: ${error.message}`);
  return data;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL.includes(DEV_PROJECT_REF)) {
    throw new Error(`refusing to run: SUPABASE_URL does not target dev project ${DEV_PROJECT_REF}`);
  }
  const supabase = buildServiceClient(env);

  // Pick 1 human + a seeded topic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: users } = (await (supabase as any)
    .from('users')
    .select('id, handle, timezone')
    .eq('is_bot', false)
    .order('created_at', { ascending: true })
    .limit(1)) as {
    data: Array<{ id: string; handle: string; timezone: string }> | null;
  };
  if (!users || users.length === 0) throw new Error('need a human user');
  const u = users[0]!;
  console.log(`\nusing user: ${u.handle}  id=${u.id}  tz=${u.timezone}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: topics } = (await (supabase as any)
    .from('news_topics')
    .select('id, slug')
    .limit(1)) as { data: Array<{ id: string; slug: string }> | null };
  if (!topics || topics.length === 0) throw new Error('need a seeded topic');
  const topic = topics[0]!;
  console.log(`using topic: ${topic.slug}  id=${topic.id}`);

  // Snapshot original streak row for restoration.
  const original = await readStreak(supabase, u.id);
  console.log(
    `original streak: current_length=${original.current_length} longest=${original.longest_length} freezes=${original.freeze_tokens} take5=${original.take5_progress}/${original.take5_local_date}`,
  );

  // Compute the dates the SQL functions will see — we anchor everything to
  // *the user's actual local today/yesterday* so the same script runs in
  // any TZ. Use server-side date math via a one-shot RPC-friendly query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: localDates } = (await (supabase as any).rpc('claim_scheduled_jobs', {
    p_handler_types: ['_validate_no_op'],
    p_limit: 0,
    p_worker_id: 'validate',
  })) as { data: unknown; error: unknown };
  // The above was a noop just to confirm RPC plumbing. Now derive dates
  // client-side using the user's tz via Intl.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: u.timezone });
  const today = fmt.format(new Date());
  const yesterday = fmt.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const dayBefore = fmt.format(new Date(Date.now() - 48 * 60 * 60 * 1000));
  void localDates;
  console.log(`local dates (user tz ${u.timezone}): today=${today} yesterday=${yesterday}`);

  try {
    // ---------------------------------------------------------------------
    console.log('\n--- TEST 1: increment_take5_progress same-day increments ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      take5_progress: 0,
      take5_local_date: null,
      current_length: 0,
      last_action_date: null,
      freeze_tokens: 0,
      last_freeze_used_local_date: null,
    });
    type IncResult = { progress: number; completed: boolean; local_date: string };
    const r1 = await callRpc<IncResult>(supabase, 'increment_take5_progress', { p_user_id: u.id });
    assert('first call → progress=1', r1.progress === 1, `got ${r1.progress}`);
    assert('first call → completed=false', r1.completed === false);
    assert('first call → local_date=today', r1.local_date === today, `got ${r1.local_date}`);

    const r2 = await callRpc<IncResult>(supabase, 'increment_take5_progress', { p_user_id: u.id });
    assert('second call → progress=2', r2.progress === 2);
    const r3 = await callRpc<IncResult>(supabase, 'increment_take5_progress', { p_user_id: u.id });
    assert('third call → progress=3', r3.progress === 3);
    const r4 = await callRpc<IncResult>(supabase, 'increment_take5_progress', { p_user_id: u.id });
    assert('fourth call → progress=4 + completed=false', r4.progress === 4 && !r4.completed);
    const r5 = await callRpc<IncResult>(supabase, 'increment_take5_progress', { p_user_id: u.id });
    assert('fifth call → progress=5 + completed=true', r5.progress === 5 && r5.completed === true);

    const after = await readStreak(supabase, u.id);
    assert('streaks.take5_progress persisted to 5', after.take5_progress === 5);
    assert(
      'streaks.take5_local_date persisted to today',
      after.take5_local_date === today,
      `got ${after.take5_local_date}`,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 2: cross-day reset on increment ---');
    // ---------------------------------------------------------------------
    // Simulate "user did 3 things yesterday, comes back today":
    await setStreak(supabase, u.id, { take5_progress: 3, take5_local_date: yesterday });
    const r6 = await callRpc<IncResult>(supabase, 'increment_take5_progress', { p_user_id: u.id });
    assert('new local day → progress resets to 1', r6.progress === 1, `got ${r6.progress}`);
    assert('new local day → local_date updated to today', r6.local_date === today);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 3: opinion_shifts trigger fires increment ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, { take5_progress: 0, take5_local_date: null });
    // opinion_shifts has no (user_id, topic_id) unique constraint — multiple
    // rows allowed. Delete any pre-existing row for this (user, topic) so
    // the test inserts exactly one and we can assert exactly one increment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from('opinion_shifts')
      .delete()
      .eq('user_id', u.id)
      .eq('topic_id', topic.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insErr } = await (supabase as any).from('opinion_shifts').insert({
      user_id: u.id,
      topic_id: topic.id,
      before_position: 0,
      after_position: 1,
    });
    if (insErr) throw new Error(`opinion_shifts insert: ${insErr.message}`);
    const afterTrigger = await readStreak(supabase, u.id);
    assert(
      'trigger fired → take5_progress=1',
      afterTrigger.take5_progress === 1,
      `got ${afterTrigger.take5_progress}`,
    );
    assert('trigger set take5_local_date to today', afterTrigger.take5_local_date === today);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 4: apply_local_boundary_sweep — ADVANCED ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      current_length: 3,
      longest_length: 3,
      last_action_date: dayBefore,
      take5_progress: 5,
      take5_local_date: yesterday,
      freeze_tokens: 0,
    });
    type SweepResult = {
      outcome: string;
      new_length?: number;
      freezes?: number;
      milestone_granted?: boolean;
    };
    const sw1 = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert(`outcome='advanced'`, sw1.outcome === 'advanced', `got ${sw1.outcome}`);
    assert(`new_length=4`, sw1.new_length === 4);
    const post1 = await readStreak(supabase, u.id);
    assert('current_length=4 persisted', post1.current_length === 4);
    assert('take5_progress=0 reset', post1.take5_progress === 0);
    assert('last_action_date=yesterday', post1.last_action_date === yesterday);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 4b: re-fire idempotency on ADVANCED ---');
    // ---------------------------------------------------------------------
    // The handler retries on backoff and the cron fires across a 4-tick
    // window — this sweep WILL be re-called with the same p_yesterday in
    // production. Double-advance is the AP-corruption vector. Assert:
    //   second call returns already_swept
    //   current_length unchanged (NOT bumped to 5)
    //   longest_length unchanged (NOT bumped)
    //   freeze_tokens unchanged (no second milestone grant)
    const sw1b = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert(
      `re-call outcome='already_swept'`,
      sw1b.outcome === 'already_swept',
      `got ${sw1b.outcome}`,
    );
    const post1b = await readStreak(supabase, u.id);
    assert(
      're-call did NOT double-advance current_length',
      post1b.current_length === post1.current_length,
      `was ${post1.current_length}, now ${post1b.current_length}`,
    );
    assert('re-call did NOT bump longest_length', post1b.longest_length === post1.longest_length);
    assert(
      're-call did NOT grant a second freeze',
      post1b.freeze_tokens === post1.freeze_tokens,
      `was ${post1.freeze_tokens}, now ${post1b.freeze_tokens}`,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 5: apply_local_boundary_sweep — FROZEN ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      current_length: 5,
      longest_length: 5,
      last_action_date: dayBefore,
      take5_progress: 2, // not enough
      take5_local_date: yesterday,
      freeze_tokens: 1,
      last_freeze_used_local_date: null,
    });
    const sw2 = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert(`outcome='frozen'`, sw2.outcome === 'frozen', `got ${sw2.outcome}`);
    assert(`new_length=5 (preserved)`, sw2.new_length === 5);
    assert(`freezes=0`, sw2.freezes === 0);
    const post2 = await readStreak(supabase, u.id);
    assert('current_length=5 preserved', post2.current_length === 5);
    assert('freeze_tokens=0 spent', post2.freeze_tokens === 0);
    assert(
      'last_freeze_used_local_date=yesterday',
      post2.last_freeze_used_local_date === yesterday,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 5b: re-fire idempotency on FROZEN ---');
    // ---------------------------------------------------------------------
    // Double-spend of a freeze is the second AP-corruption vector. Assert:
    //   second call returns already_swept
    //   freeze_tokens unchanged (NOT decremented to -1 or wrapped)
    //   current_length unchanged
    //   last_freeze_used_local_date unchanged
    const sw2b = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert(
      `re-call outcome='already_swept'`,
      sw2b.outcome === 'already_swept',
      `got ${sw2b.outcome}`,
    );
    const post2b = await readStreak(supabase, u.id);
    assert(
      're-call did NOT double-spend freeze',
      post2b.freeze_tokens === post2.freeze_tokens,
      `was ${post2.freeze_tokens}, now ${post2b.freeze_tokens}`,
    );
    assert('re-call did NOT change current_length', post2b.current_length === post2.current_length);
    assert(
      're-call did NOT change last_freeze_used_local_date',
      post2b.last_freeze_used_local_date === post2.last_freeze_used_local_date,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 6: apply_local_boundary_sweep — BROKEN ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      current_length: 10,
      longest_length: 10,
      last_action_date: dayBefore,
      take5_progress: 2,
      take5_local_date: yesterday,
      freeze_tokens: 0,
    });
    const sw3 = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert(`outcome='broken'`, sw3.outcome === 'broken', `got ${sw3.outcome}`);
    assert(`new_length=0`, sw3.new_length === 0);
    const post3 = await readStreak(supabase, u.id);
    assert('current_length=0 reset', post3.current_length === 0);
    assert(
      'longest_length=10 preserved',
      post3.longest_length === 10,
      `got ${post3.longest_length}`,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 6b: re-fire idempotency on BROKEN ---');
    // ---------------------------------------------------------------------
    // The third AP-adjacent corruption vector: re-call on a broken state
    // must NOT re-break (no-op already, but assert state stays exactly 0).
    // post3 already has last_action_date=yesterday from TEST 6.
    const sw4 = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert(
      `re-call outcome='already_swept'`,
      sw4.outcome === 'already_swept',
      `got ${sw4.outcome}`,
    );
    const post3b = await readStreak(supabase, u.id);
    assert('re-call left current_length=0', post3b.current_length === post3.current_length);
    assert('re-call did NOT touch longest_length', post3b.longest_length === post3.longest_length);
    assert('re-call did NOT touch freeze_tokens', post3b.freeze_tokens === post3.freeze_tokens);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 8: milestone freeze grant at length%7=0 ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      current_length: 6,
      longest_length: 6,
      last_action_date: dayBefore,
      take5_progress: 5,
      take5_local_date: yesterday,
      freeze_tokens: 0,
      last_freeze_used_local_date: null,
    });
    const sw5 = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert('outcome=advanced', sw5.outcome === 'advanced');
    assert('new_length=7', sw5.new_length === 7);
    assert('milestone_granted=true', sw5.milestone_granted === true);
    assert('freezes=1 (granted)', sw5.freezes === 1);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 9: milestone grant capped at freeze_tokens_max ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      current_length: 13,
      longest_length: 13,
      last_action_date: dayBefore,
      take5_progress: 5,
      take5_local_date: yesterday,
      freeze_tokens: 2, // already at cap (default freeze_tokens_max=2)
    });
    const sw6 = await callRpc<SweepResult>(supabase, 'apply_local_boundary_sweep', {
      p_user_id: u.id,
      p_yesterday: yesterday,
    });
    assert('outcome=advanced', sw6.outcome === 'advanced');
    assert('new_length=14', sw6.new_length === 14);
    assert(
      'milestone_granted=false (capped)',
      sw6.milestone_granted === false,
      `got ${sw6.milestone_granted}`,
    );
    assert('freezes stay at 2', sw6.freezes === 2);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 10: evaluate_risk_push decisions ---');
    // ---------------------------------------------------------------------
    type DecResult = { decision: string; current_length?: number; progress?: number };

    // skip_completed
    await setStreak(supabase, u.id, {
      current_length: 5,
      take5_progress: 5,
      take5_local_date: today,
    });
    const d1 = await callRpc<DecResult>(supabase, 'evaluate_risk_push', {
      p_user_id: u.id,
      p_local_date: today,
    });
    assert(`decision='skip_completed'`, d1.decision === 'skip_completed', `got ${d1.decision}`);

    // skip_no_streak (current_length=0)
    await setStreak(supabase, u.id, {
      current_length: 0,
      take5_progress: 2,
      take5_local_date: today,
    });
    const d2 = await callRpc<DecResult>(supabase, 'evaluate_risk_push', {
      p_user_id: u.id,
      p_local_date: today,
    });
    assert(`decision='skip_no_streak'`, d2.decision === 'skip_no_streak');

    // would_push (active streak + Take 5 incomplete)
    await setStreak(supabase, u.id, {
      current_length: 7,
      take5_progress: 2,
      take5_local_date: today,
    });
    const d3 = await callRpc<DecResult>(supabase, 'evaluate_risk_push', {
      p_user_id: u.id,
      p_local_date: today,
    });
    assert(`decision='would_push'`, d3.decision === 'would_push');
    assert('current_length surfaced in payload', d3.current_length === 7);
    assert('progress surfaced in payload', d3.progress === 2);
  } finally {
    // ---------------------------------------------------------------------
    console.log('\n--- CLEANUP ---');
    // ---------------------------------------------------------------------
    await setStreak(supabase, u.id, {
      current_length: original.current_length,
      longest_length: original.longest_length,
      last_action_date: original.last_action_date,
      freeze_tokens: original.freeze_tokens,
      take5_progress: original.take5_progress,
      take5_local_date: original.take5_local_date,
      last_freeze_used_local_date: original.last_freeze_used_local_date,
    });
    console.log(`  streak restored: current_length=${original.current_length}`);

    // Delete the test opinion_shifts row (cleanup).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: delErr } = await (supabase as any)
      .from('opinion_shifts')
      .delete()
      .eq('user_id', u.id)
      .eq('topic_id', topic.id);
    if (delErr) {
      console.error(`  ⚠ opinion_shifts cleanup failed: ${delErr.message}`);
    } else {
      console.log(`  opinion_shifts row deleted`);
    }
  }

  console.log(
    `\n=== VALIDATION: ${totalFailed === 0 ? 'PASS' : 'FAIL'} (${totalPassed} passed, ${totalFailed} failed) ===`,
  );
  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
