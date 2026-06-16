import { describe, expect, it, vi } from 'vitest';

import {
  buildNotificationBody,
  buildPushDeliverHandler,
  type SendOutcome,
  type WebPushSender,
  __testing,
} from '../../src/jobs/push-deliver.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const { STALENESS_WINDOW_MS } = __testing;

const USER_ID = '795d3031-bfe6-47e3-9a35-7e6440122522';

// ---------------------------------------------------------------------------
// Pure copy helpers — pluralization is EXPLICIT, not assumed.
// ---------------------------------------------------------------------------

describe('buildNotificationBody — pluralization', () => {
  it('omits the freezes phrase entirely at freezes=0 (no coercive framing)', () => {
    expect(buildNotificationBody({ streakLength: 6, progress: 3, freezes: 0 })).toBe(
      "day 6. 3/5 shifted today. open it if you want; skip if you don't.",
    );
  });

  it('renders "1 freeze banked" — singular, never "1 freezes banked"', () => {
    expect(buildNotificationBody({ streakLength: 47, progress: 4, freezes: 1 })).toBe(
      "day 47. 4/5 shifted today. open it if you want; skip if you don't. 1 freeze banked.",
    );
  });

  it('renders "2 freezes banked" — plural, never "2 freeze banked"', () => {
    expect(buildNotificationBody({ streakLength: 21, progress: 0, freezes: 2 })).toBe(
      "day 21. 0/5 shifted today. open it if you want; skip if you don't. 2 freezes banked.",
    );
  });
});

// ---------------------------------------------------------------------------
// Fake supabase — minimal, table-aware. Mirrors the risk-push.test.ts shape.
// ---------------------------------------------------------------------------

interface FakeUser {
  id: string;
  notification_preferences: Record<string, unknown> | null;
}

interface FakeSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  last_delivered_at: string | null;
}

interface FakeState {
  users: FakeUser[];
  subscriptions: FakeSubscription[];
  rowUpdates: { id: string; patch: Record<string, unknown> }[];
  subscriptionUpdates: { id: string; patch: Record<string, unknown> }[];
  fetchUserError: { message: string } | null;
  fetchSubsError: { message: string } | null;
}

function buildSupabase(state: FakeState): ServiceClient {
  const fromImpl = (table: string) => ({
    select(_cols: string) {
      const handler = {
        _filters: [] as { col: string; val: unknown }[],
        _isNull: [] as string[],
        eq(col: string, val: unknown) {
          this._filters.push({ col, val });
          return this;
        },
        is(col: string, val: unknown) {
          if (val === null) this._isNull.push(col);
          return this;
        },
        maybeSingle() {
          if (table === 'users') {
            if (state.fetchUserError) {
              return Promise.resolve({ data: null, error: state.fetchUserError });
            }
            const row = state.users.find((u) =>
              this._filters.every((f) => (u as Record<string, unknown>)[f.col] === f.val),
            );
            return Promise.resolve({
              data: row
                ? ({
                    notification_preferences: row.notification_preferences ?? {},
                  } as Record<string, unknown>)
                : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown[]; error: { message: string } | null }) => unknown) {
          if (table === 'user_push_subscriptions') {
            if (state.fetchSubsError) {
              return Promise.resolve({ data: [], error: state.fetchSubsError }).then(resolve);
            }
            const rows = state.subscriptions
              .filter((s) =>
                this._filters.every((f) => (s as Record<string, unknown>)[f.col] === f.val),
              )
              .filter((s) =>
                this._isNull.every((col) => (s as Record<string, unknown>)[col] === null),
              )
              .map((s) => ({
                id: s.id,
                endpoint: s.endpoint,
                p256dh: s.p256dh,
                auth: s.auth,
              }));
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return handler;
    },
    update(patch: Record<string, unknown>) {
      return {
        eq(col: string, val: unknown) {
          if (table === 'scheduled_jobs') {
            state.rowUpdates.push({ id: String(val), patch });
          } else if (table === 'user_push_subscriptions') {
            state.subscriptionUpdates.push({ id: String(val), patch });
            const sub = state.subscriptions.find((s) => s.id === val);
            if (sub) Object.assign(sub, patch);
          }
          // Note: col not used; tests assert on patches/state.
          void col;
          return Promise.resolve({ error: null });
        },
      };
    },
  });
  return { from: fromImpl } as unknown as ServiceClient;
}

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

function row(partial: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: partial.id ?? 'pd-1',
    job_type: partial.job_type ?? 'push_deliver',
    idempotency_key: partial.idempotency_key ?? 'src-row-1',
    target_user_id: 'target_user_id' in partial ? (partial.target_user_id ?? null) : USER_ID,
    payload: partial.payload ?? {
      source_job_id: 'src-row-1',
      current_length: 6,
      progress: 3,
      freezes: 0,
    },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'workers-test',
    last_error: null,
    processed_at: null,
    created_at: partial.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function baseState(opts: Partial<FakeState> = {}): FakeState {
  return {
    users: opts.users ?? [{ id: USER_ID, notification_preferences: {} }],
    subscriptions: opts.subscriptions ?? [
      {
        id: 'sub-1',
        user_id: USER_ID,
        endpoint: 'https://push.example/abc',
        p256dh: 'p256dh-1',
        auth: 'auth-1',
        disabled_at: null,
        disabled_reason: null,
        last_delivered_at: null,
      },
    ],
    rowUpdates: [],
    subscriptionUpdates: [],
    fetchUserError: opts.fetchUserError ?? null,
    fetchSubsError: opts.fetchSubsError ?? null,
  };
}

function buildSender(outcome: SendOutcome | SendOutcome[]): WebPushSender & {
  calls: { endpoint: string; payload: string }[];
} {
  const calls: { endpoint: string; payload: string }[] = [];
  const outcomes = Array.isArray(outcome) ? [...outcome] : [outcome];
  const sender = {
    calls,
    send: vi.fn(async (sub: { endpoint: string }, payload: string) => {
      calls.push({ endpoint: sub.endpoint, payload });
      return outcomes.shift() ?? { kind: 'sent' };
    }),
  };
  return sender as WebPushSender & { calls: { endpoint: string; payload: string }[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pushDeliverHandler', () => {
  it('happy path: delivers to one sub, touches last_delivered_at, stamps delivered', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.endpoint).toBe('https://push.example/abc');
    // Body uses the explicit pluralization helper — assert one rendering end-to-end.
    const sentBody = JSON.parse(sender.calls[0]!.payload) as { body: string; title: string };
    expect(sentBody.title).toBe('take 5 — your call');
    expect(sentBody.body).toContain(
      "day 6. 3/5 shifted today. open it if you want; skip if you don't.",
    );

    // Sub touched.
    expect(state.subscriptionUpdates).toHaveLength(1);
    expect(state.subscriptionUpdates[0]!.id).toBe('sub-1');
    expect(state.subscriptionUpdates[0]!.patch).toHaveProperty('last_delivered_at');

    // Row stamped delivered.
    const rowPatch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(rowPatch.payload.delivery_status).toBe('delivered');
  });

  it('skipped_no_vapid: stamps row, never calls send, no sub updates', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildPushDeliverHandler(null); // no sender

    await handler(row(), { supabase, logger });

    expect(state.subscriptionUpdates).toHaveLength(0);
    expect(state.rowUpdates).toHaveLength(1);
    const patch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(patch.payload.delivery_status).toBe('skipped_no_vapid');
    expect(logger.calls.find((c) => c.obj.event === 'push.deliver.skipped_no_vapid')).toBeDefined();
  });

  it('skipped_stale: row.created_at older than 15 min → no send, no sub fetch', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    const staleCreatedAt = new Date(Date.now() - STALENESS_WINDOW_MS - 60_000).toISOString();
    await handler(row({ created_at: staleCreatedAt }), { supabase, logger });

    expect(sender.calls).toHaveLength(0);
    const patch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(patch.payload.delivery_status).toBe('skipped_stale');
  });

  it('skipped_opt_out: streak_risk_push=false → no send', async () => {
    const state = baseState({
      users: [{ id: USER_ID, notification_preferences: { streak_risk_push: false } }],
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(sender.calls).toHaveLength(0);
    const patch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(patch.payload.delivery_status).toBe('skipped_opt_out');
  });

  it('default-on policy: absent prefs key → delivers', async () => {
    const state = baseState({
      users: [{ id: USER_ID, notification_preferences: null }], // null prefs entirely
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(sender.calls).toHaveLength(1);
  });

  it('skipped_no_subscription: no active subs → no send', async () => {
    const state = baseState({ subscriptions: [] });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(sender.calls).toHaveLength(0);
    const patch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(patch.payload.delivery_status).toBe('skipped_no_subscription');
  });

  it('410 Gone → soft-deletes the sub with disabled_reason=gone; row marked failed', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'gone' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(state.subscriptionUpdates).toHaveLength(1);
    const subPatch = state.subscriptionUpdates[0]!.patch as {
      disabled_reason: string;
      disabled_at: string;
    };
    expect(subPatch.disabled_reason).toBe('gone');
    expect(typeof subPatch.disabled_at).toBe('string');

    const rowPatch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(rowPatch.payload.delivery_status).toBe('failed');
  });

  it('401 Unauthorized → soft-deletes the sub with disabled_reason=unauthorized', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'unauthorized' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    const subPatch = state.subscriptionUpdates[0]!.patch as { disabled_reason: string };
    expect(subPatch.disabled_reason).toBe('unauthorized');
  });

  it('413 payload_too_large → logs warn but does NOT soft-delete or throw', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'payload_too_large' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(state.subscriptionUpdates).toHaveLength(0);
    expect(
      logger.calls.find((c) => c.obj.event === 'push.deliver.payload_too_large'),
    ).toBeDefined();
    const rowPatch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(rowPatch.payload.delivery_status).toBe('failed');
  });

  it('transient 5xx → throws (scheduler retries with backoff); row payload NOT stamped', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'transient', statusCode: 503, message: 'service down' });
    const handler = buildPushDeliverHandler(sender);

    await expect(handler(row(), { supabase, logger })).rejects.toThrow(
      /transient send failure \(503\): service down/,
    );
    // Row payload NOT stamped — scheduler will retry the whole row.
    expect(state.rowUpdates).toHaveLength(0);
  });

  it('mixed outcomes across 2 subs (sent + gone) → partial + per_sub records both', async () => {
    const state = baseState({
      subscriptions: [
        {
          id: 'sub-A',
          user_id: USER_ID,
          endpoint: 'https://push.example/A',
          p256dh: 'p',
          auth: 'a',
          disabled_at: null,
          disabled_reason: null,
          last_delivered_at: null,
        },
        {
          id: 'sub-B',
          user_id: USER_ID,
          endpoint: 'https://push.example/B',
          p256dh: 'p',
          auth: 'a',
          disabled_at: null,
          disabled_reason: null,
          last_delivered_at: null,
        },
      ],
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender([{ kind: 'sent' }, { kind: 'gone' }]);
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(sender.calls).toHaveLength(2);
    // sub-A touched, sub-B soft-deleted.
    expect(state.subscriptionUpdates).toHaveLength(2);

    const rowPatch = state.rowUpdates[0]!.patch as {
      payload: { delivery_status: string; per_sub: { subscription_id: string; outcome: string }[] };
    };
    expect(rowPatch.payload.delivery_status).toBe('partial');
    expect(rowPatch.payload.per_sub).toEqual([
      { subscription_id: 'sub-A', outcome: 'sent' },
      { subscription_id: 'sub-B', outcome: 'gone' },
    ]);
  });

  it('throws when target_user_id is missing (defense in depth — trigger should prevent)', async () => {
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);
    await expect(handler(row({ target_user_id: null }), { supabase, logger })).rejects.toThrow(
      /target_user_id is required/,
    );
    expect(sender.calls).toHaveLength(0);
  });

  it('deleted user (no users row) → treated as opt-out, no send, no throw', async () => {
    const state = baseState({ users: [] });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    await handler(row(), { supabase, logger });

    expect(sender.calls).toHaveLength(0);
    const patch = state.rowUpdates[0]!.patch as { payload: { delivery_status: string } };
    expect(patch.payload.delivery_status).toBe('skipped_opt_out');
  });

  it('honours upstream decision — never re-evaluates timing / streak / opt-out beyond the prefs lookup', async () => {
    // This is the structural assertion: the handler does at most three reads
    // (user prefs, subs, send-per-sub) and at most three write classes (sub
    // touch, sub soft-delete, row payload stamp). No clock arithmetic
    // against current_length / progress / freezes. The §12 hard rule —
    // never push at 11 PM local — is enforced by the upstream cron
    // predicate (`risk_push_check`) and the row's own created_at staleness
    // window, NOT by re-deriving local time here.
    const state = baseState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const sender = buildSender({ kind: 'sent' });
    const handler = buildPushDeliverHandler(sender);

    // Pass payload values that would be nonsensical if the handler did any
    // decision logic (current_length=0 = no active streak per evaluate_risk_push).
    // The handler MUST still deliver because the decision was already
    // stamped upstream — it's not this handler's job to second-guess.
    await handler(
      row({
        payload: {
          source_job_id: 'src-x',
          current_length: 0,
          progress: 9999,
          freezes: -5,
        },
      }),
      { supabase, logger },
    );

    expect(sender.calls).toHaveLength(1);
    const sentBody = JSON.parse(sender.calls[0]!.payload) as { body: string };
    // Numbers flow through verbatim; the handler does not validate them.
    // (freezes < 0 falls into the "omit freezes phrase" branch — coverage of
    // the helper's defensive default.)
    expect(sentBody.body).toContain('day 0. 9999/5 shifted today');
  });
});
