// Integration validation for the web-push delivery PR. Exercises:
//   1. The Postgres trigger — UPDATE-ing a risk_push row into the
//      (status='done', payload.decision='would_push') state should insert a
//      push_deliver row with idempotency_key = source row id.
//   2. The push_deliver handler — happy path (sent), opt-out path,
//      staleness path, 410 soft-delete path. Uses a fake WebPushSender so
//      no real network traffic and no VAPID required.
//   3. The lifecycle on the user_push_subscriptions row — 410 stamps
//      disabled_at + disabled_reason='gone'; successful send touches
//      last_delivered_at.
//
// Run:
//   (set -a; . ./.env.local; set +a; \
//      pnpm --filter=@diktat/workers exec tsx scripts/validate-web-push-delivery.ts)
//
// Hard guard: aborts unless SUPABASE_URL targets the dev project ref.
//
// What it does NOT do (out of scope for this script):
//   - Real VAPID signing or network send (the unit suite covers the
//     normalized outcomes; this script exercises the DB wiring).
//   - The browser-side subscribe flow (manual or webapp-testing path).

import {
  buildPushDeliverHandler,
  type SendOutcome,
  type WebPushSender,
} from '../src/jobs/push-deliver.js';
import type { ScheduledJobRow } from '../src/jobs/scheduler.js';
import { buildLogger } from '../src/logger.js';
import { loadEnv } from '../src/env.js';
import { buildServiceClient, type ServiceClient } from '../src/supabase.js';

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

interface UserRow {
  id: string;
  handle: string;
  notification_preferences: Record<string, unknown> | null;
}

interface ScheduledRowSnap {
  id: string;
  status: string;
  payload: Record<string, unknown>;
  target_user_id: string | null;
  created_at: string;
  processed_at: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = (c: ServiceClient) => c as any;

async function pickHuman(supabase: ServiceClient): Promise<UserRow> {
  const { data, error } = await sb(supabase)
    .from('users')
    .select('id, handle, notification_preferences')
    .eq('is_bot', false)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error || !data?.[0]) throw new Error(`pickHuman: ${error?.message ?? 'no users'}`);
  return data[0] as UserRow;
}

async function setPrefs(
  supabase: ServiceClient,
  userId: string,
  prefs: Record<string, unknown>,
): Promise<void> {
  const { error } = await sb(supabase)
    .from('users')
    .update({ notification_preferences: prefs })
    .eq('id', userId);
  if (error) throw new Error(`setPrefs: ${error.message}`);
}

async function insertRiskPushDoneRow(
  supabase: ServiceClient,
  userId: string,
  localDate: string,
): Promise<string> {
  // INSERT pending then UPDATE-to-done so the trigger sees the eligibility
  // edge (pending → done + would_push), matching the real flow.
  const ts = Date.now();
  const { data: ins, error: insErr } = await sb(supabase)
    .from('scheduled_jobs')
    .insert({
      job_type: 'risk_push',
      target_user_id: userId,
      idempotency_key: `validate-web-push-${ts}`,
      payload: { local_date: localDate, user_tz: 'America/New_York' },
    })
    .select('id')
    .single();
  if (insErr || !ins) throw new Error(`insertRiskPush: ${insErr?.message ?? 'no row'}`);
  const rowId = (ins as { id: string }).id;

  const { error: updErr } = await sb(supabase)
    .from('scheduled_jobs')
    .update({
      status: 'done',
      processed_at: new Date().toISOString(),
      payload: {
        local_date: localDate,
        user_tz: 'America/New_York',
        decision: 'would_push',
        evaluated_at: new Date().toISOString(),
        current_length: 7,
        progress: 3,
        freezes: 1,
        freezes_max: 2,
      },
    })
    .eq('id', rowId);
  if (updErr) throw new Error(`updateRiskPushToDone: ${updErr.message}`);
  return rowId;
}

async function fetchPushDeliverFor(
  supabase: ServiceClient,
  sourceRowId: string,
): Promise<ScheduledRowSnap | null> {
  const { data, error } = await sb(supabase)
    .from('scheduled_jobs')
    .select('id, status, payload, target_user_id, created_at, processed_at')
    .eq('job_type', 'push_deliver')
    .eq('idempotency_key', sourceRowId)
    .maybeSingle();
  if (error) throw new Error(`fetchPushDeliver: ${error.message}`);
  return (data as ScheduledRowSnap | null) ?? null;
}

async function ensureSubscription(
  supabase: ServiceClient,
  userId: string,
  endpoint: string,
): Promise<string> {
  const { data, error } = await sb(supabase)
    .from('user_push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh: 'validate-p256dh',
        auth: 'validate-auth',
        user_agent: 'validate-script',
        disabled_at: null,
        disabled_reason: null,
      },
      { onConflict: 'user_id,endpoint' },
    )
    .select('id')
    .single();
  if (error || !data) throw new Error(`ensureSubscription: ${error?.message ?? 'no row'}`);
  return (data as { id: string }).id;
}

async function readSub(
  supabase: ServiceClient,
  id: string,
): Promise<{
  disabled_at: string | null;
  disabled_reason: string | null;
  last_delivered_at: string | null;
}> {
  const { data, error } = await sb(supabase)
    .from('user_push_subscriptions')
    .select('disabled_at, disabled_reason, last_delivered_at')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`readSub: ${error?.message}`);
  return data as {
    disabled_at: string | null;
    disabled_reason: string | null;
    last_delivered_at: string | null;
  };
}

async function cleanup(
  supabase: ServiceClient,
  rowIds: string[],
  subId: string | null,
): Promise<void> {
  if (rowIds.length > 0) {
    await sb(supabase).from('scheduled_jobs').delete().in('id', rowIds);
  }
  if (subId) {
    await sb(supabase).from('user_push_subscriptions').delete().eq('id', subId);
  }
}

function fakeSender(outcomes: SendOutcome[]): WebPushSender & { calls: number } {
  let i = 0;
  const sender = {
    calls: 0,
    async send(_sub: { endpoint: string; p256dh: string; auth: string }, _payload: string) {
      sender.calls += 1;
      const next = outcomes[i] ?? { kind: 'sent' };
      i += 1;
      return next;
    },
  };
  return sender as WebPushSender & { calls: number };
}

// Backdate a scheduled_jobs row's created_at so the staleness check trips.
async function backdateCreatedAt(
  supabase: ServiceClient,
  rowId: string,
  ageMinutes: number,
): Promise<void> {
  const dt = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString();
  const { error } = await sb(supabase)
    .from('scheduled_jobs')
    .update({ created_at: dt })
    .eq('id', rowId);
  if (error) throw new Error(`backdateCreatedAt: ${error.message}`);
}

async function fetchRow(supabase: ServiceClient, rowId: string): Promise<ScheduledRowSnap> {
  const { data, error } = await sb(supabase)
    .from('scheduled_jobs')
    .select('id, status, payload, target_user_id, created_at, processed_at')
    .eq('id', rowId)
    .single();
  if (error || !data) throw new Error(`fetchRow: ${error?.message}`);
  return data as ScheduledRowSnap;
}

function rowToScheduledJobRow(snap: ScheduledRowSnap): ScheduledJobRow {
  // Minimal shape — the handler only reads id, target_user_id, payload, created_at.
  return {
    id: snap.id,
    job_type: 'push_deliver',
    idempotency_key: '',
    target_user_id: snap.target_user_id,
    payload: snap.payload,
    status: snap.status as ScheduledJobRow['status'],
    attempts: 1,
    max_attempts: 5,
    available_at: snap.created_at,
    locked_at: snap.created_at,
    locked_by: 'validate-script',
    last_error: null,
    processed_at: snap.processed_at,
    created_at: snap.created_at,
    updated_at: snap.created_at,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL.includes(DEV_PROJECT_REF)) {
    console.error(`Refusing to run: SUPABASE_URL does not target ${DEV_PROJECT_REF}.`);
    process.exit(2);
  }
  const supabase = buildServiceClient(env);
  const logger = buildLogger(env);

  console.log('Web-push delivery validation against dev DB.\n');

  const user = await pickHuman(supabase);
  const originalPrefs = user.notification_preferences;
  const today = new Date().toISOString().slice(0, 10);
  const rowsCreated: string[] = [];
  let subId: string | null = null;

  try {
    // -----------------------------------------------------------------
    // 1) Trigger fires on risk_push → push_deliver
    // -----------------------------------------------------------------
    console.log('▶ Trigger: risk_push (would_push) → push_deliver row inserted');
    // Make sure prefs are default-on for this test.
    await setPrefs(supabase, user.id, {});
    const sourceId1 = await insertRiskPushDoneRow(supabase, user.id, today);
    rowsCreated.push(sourceId1);
    const delivered = await fetchPushDeliverFor(supabase, sourceId1);
    if (delivered) rowsCreated.push(delivered.id);
    assert('push_deliver row created', delivered !== null);
    assert(
      'push_deliver targets the same user',
      delivered?.target_user_id === user.id,
      `got ${delivered?.target_user_id}`,
    );
    assert(
      'payload carries decision context from source',
      delivered?.payload['current_length'] === 7 &&
        delivered?.payload['progress'] === 3 &&
        delivered?.payload['freezes'] === 1,
      JSON.stringify(delivered?.payload),
    );
    // Re-UPDATE the same source row to the same eligible state — trigger
    // should NOT create a duplicate (was_eligible == is_eligible).
    await sb(supabase)
      .from('scheduled_jobs')
      .update({ payload: { ...delivered?.payload, _bump: 1 } })
      .eq('id', sourceId1);
    const dup = await sb(supabase)
      .from('scheduled_jobs')
      .select('id')
      .eq('job_type', 'push_deliver')
      .eq('idempotency_key', sourceId1);
    assert(
      'trigger does not re-fire on no-op UPDATEs',
      (dup.data as unknown[] | null)?.length === 1,
      `count=${(dup.data as unknown[] | null)?.length}`,
    );

    // -----------------------------------------------------------------
    // 2) Happy path delivery — sender returns sent
    // -----------------------------------------------------------------
    console.log('\n▶ Handler: happy path delivers + touches last_delivered_at');
    subId = await ensureSubscription(
      supabase,
      user.id,
      `https://push.example/validate-${Date.now()}`,
    );
    const sender = fakeSender([{ kind: 'sent' }]);
    const handler = buildPushDeliverHandler(sender);
    const pdRow = await fetchRow(supabase, delivered!.id);
    await handler(rowToScheduledJobRow(pdRow), { supabase, logger });
    assert('sender invoked once', sender.calls === 1);
    const subAfterSent = await readSub(supabase, subId);
    assert('last_delivered_at touched on success', subAfterSent.last_delivered_at !== null);
    const pdAfterSent = await fetchRow(supabase, delivered!.id);
    assert(
      'push_deliver payload stamped delivery_status=delivered',
      pdAfterSent.payload['delivery_status'] === 'delivered',
      JSON.stringify(pdAfterSent.payload),
    );

    // -----------------------------------------------------------------
    // 3) Opt-out path — explicit streak_risk_push=false
    // -----------------------------------------------------------------
    console.log('\n▶ Handler: opt-out skips delivery');
    await setPrefs(supabase, user.id, { streak_risk_push: false });
    const sourceId2 = await insertRiskPushDoneRow(supabase, user.id, today);
    rowsCreated.push(sourceId2);
    const delivered2 = await fetchPushDeliverFor(supabase, sourceId2);
    if (delivered2) rowsCreated.push(delivered2.id);
    const senderOptOut = fakeSender([{ kind: 'sent' }]);
    const handlerOptOut = buildPushDeliverHandler(senderOptOut);
    await handlerOptOut(rowToScheduledJobRow(delivered2!), { supabase, logger });
    assert('sender NOT invoked on opt-out', senderOptOut.calls === 0);
    const pdOptOut = await fetchRow(supabase, delivered2!.id);
    assert(
      'opt-out stamps delivery_status=skipped_opt_out',
      pdOptOut.payload['delivery_status'] === 'skipped_opt_out',
      JSON.stringify(pdOptOut.payload),
    );
    // Restore default-on.
    await setPrefs(supabase, user.id, {});

    // -----------------------------------------------------------------
    // 4) Stale path — row.created_at older than 15 min
    // -----------------------------------------------------------------
    console.log('\n▶ Handler: staleness skip protects against late delivery');
    const sourceId3 = await insertRiskPushDoneRow(supabase, user.id, today);
    rowsCreated.push(sourceId3);
    const delivered3 = await fetchPushDeliverFor(supabase, sourceId3);
    if (delivered3) rowsCreated.push(delivered3.id);
    await backdateCreatedAt(supabase, delivered3!.id, 20);
    const senderStale = fakeSender([{ kind: 'sent' }]);
    const handlerStale = buildPushDeliverHandler(senderStale);
    const pdStaleRow = await fetchRow(supabase, delivered3!.id);
    await handlerStale(rowToScheduledJobRow(pdStaleRow), { supabase, logger });
    assert('sender NOT invoked on stale row', senderStale.calls === 0);
    const pdStale = await fetchRow(supabase, delivered3!.id);
    assert(
      'stale row stamps delivery_status=skipped_stale',
      pdStale.payload['delivery_status'] === 'skipped_stale',
    );

    // -----------------------------------------------------------------
    // 5) 410 Gone path — soft-deletes the subscription
    // -----------------------------------------------------------------
    console.log('\n▶ Handler: 410 Gone soft-deletes the subscription');
    const sourceId4 = await insertRiskPushDoneRow(supabase, user.id, today);
    rowsCreated.push(sourceId4);
    const delivered4 = await fetchPushDeliverFor(supabase, sourceId4);
    if (delivered4) rowsCreated.push(delivered4.id);
    const senderGone = fakeSender([{ kind: 'gone' }]);
    const handlerGone = buildPushDeliverHandler(senderGone);
    await handlerGone(rowToScheduledJobRow(delivered4!), { supabase, logger });
    assert('sender invoked', senderGone.calls === 1);
    const subAfterGone = await readSub(supabase, subId);
    assert(
      'subscription soft-deleted with disabled_reason=gone',
      subAfterGone.disabled_at !== null && subAfterGone.disabled_reason === 'gone',
      JSON.stringify(subAfterGone),
    );
  } finally {
    // Restore prefs.
    await setPrefs(supabase, user.id, originalPrefs ?? {});
    await cleanup(supabase, rowsCreated, subId);
    console.log('\nCleanup complete.');
  }

  console.log(`\n${totalPassed} passed, ${totalFailed} failed.`);
  process.exit(totalFailed === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('Validation script failed:', err);
  process.exit(2);
});
