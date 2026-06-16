// push_deliver handler — consumes the decision trail stamped by the
// risk_push handler (PR 4.4) and dispatches actual web-push notifications.
//
// Eligible rows are inserted into scheduled_jobs by the
// enqueue_push_deliver_on_decision trigger when a risk_push row transitions
// into (status='done', payload.decision='would_push'). One push_deliver row
// per decision; idempotency_key on push_deliver is the source row id.
//
// ADDICTION compliance — this handler is DECISION-HONORING, not
// DECISION-MAKING:
//   - The 9 PM local-time window is enforced upstream by the
//     risk_push_check pg_cron predicate.
//   - The "active streak + Take 5 incomplete" gate is enforced by
//     evaluate_risk_push and re-checked by the risk_push handler at claim
//     time.
//   - The streak-break path emits zero notifications by the
//     ADDICTION_ARCHITECTURE.md §11.5 silent-break contract.
// The only humane-design surface inside this handler is (a) the body copy
// and (b) the 15-min staleness guard that prevents a delayed delivery from
// becoming a de-facto 11 PM push (the §12 hard rule).
//
// What this handler does:
//   1. Staleness check — row.created_at within 15 min, else skipped_stale.
//   2. Opt-out check — users.notification_preferences.streak_risk_push
//      defaults to true; if explicit false, skipped_opt_out.
//   3. Subscription lookup — active (disabled_at is null) subs for the
//      target user; empty -> skipped_no_subscription.
//   4. Build the notification payload (see buildNotificationBody).
//   5. For each subscription, attempt send. Per-outcome:
//        - sent           -> touch last_delivered_at
//        - gone (404/410) -> soft-delete with disabled_reason='gone'
//        - unauthorized   -> soft-delete with disabled_reason='unauthorized'
//        - payload_too_large -> log warn, skip (body must stay short)
//        - transient (429/5xx) -> throw -> scheduler retries with backoff
//   6. Stamp delivery_status into this row's own payload — never back
//      into the source risk_push row's payload (immutable decision trail).

import type { JobHandler, ScheduledJobRow } from './scheduler.js';

const STALENESS_WINDOW_MS = 15 * 60 * 1000;

/** Input shape that the trigger stamps onto the push_deliver row's payload.
 *  Forwarded verbatim from the source risk_push row by the trigger. */
interface PushDeliverPayload {
  readonly source_job_id?: string;
  readonly current_length?: number | null;
  readonly progress?: number | null;
  readonly freezes?: number | null;
}

type DeliveryStatus =
  | 'delivered'
  | 'partial'
  | 'failed'
  | 'skipped_stale'
  | 'skipped_opt_out'
  | 'skipped_no_subscription'
  | 'skipped_no_vapid';

interface SubscriptionRow {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Discriminated outcome from the web-push library, normalized so the
 *  handler logic stays driver-agnostic. */
export type SendOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'payload_too_large' }
  | { readonly kind: 'transient'; readonly statusCode: number; readonly message: string };

/** Injected at boot in apps/workers/src/index.ts with VAPID env closed over.
 *  Tests pass a fake to assert behaviour without hitting the network. */
export interface WebPushSender {
  send(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: string,
  ): Promise<SendOutcome>;
}

/** Per-sub result recorded into the row's payload for diagnostics. */
interface PerSubResult {
  readonly subscription_id: string;
  readonly outcome: SendOutcome['kind'];
  readonly statusCode?: number;
  readonly message?: string;
}

/** Build the notification body. Pluralization on "freeze[s] banked" is
 *  EXPLICIT — never assumed. Omitted entirely when freezes <= 0 to avoid
 *  coercive "finish to bank one" framing. */
export function buildNotificationBody(input: {
  streakLength: number;
  progress: number;
  freezes: number;
}): string {
  const base = `day ${input.streakLength}. ${input.progress}/5 shifted today. open it if you want; skip if you don't.`;
  if (input.freezes <= 0) return base;
  const noun = input.freezes === 1 ? 'freeze' : 'freezes';
  return `${base} ${input.freezes} ${noun} banked.`;
}

/** Build the full notification JSON the service worker reads. The SW calls
 *  self.registration.showNotification(title, options) using these fields. */
export function buildNotificationPayload(input: {
  streakLength: number;
  progress: number;
  freezes: number;
}): {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  requireInteraction: boolean;
  data: { click_action: string };
} {
  return {
    title: 'take 5 — your call',
    body: buildNotificationBody(input),
    // Web-app manifest already serves these under /icons/ — reuse rather
    // than ship a fourth asset. Android browsers downsample the icon when
    // no monochrome badge is supplied; that's an acceptable V1 cosmetic
    // limitation. A dedicated badge-96 monochrome asset is the polish.
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Coalesces a same-day repeat into a single notification instead of
    // stacking. Clock-drift edge case defense.
    tag: 'streak_risk_push',
    requireInteraction: false,
    data: { click_action: '/take5' },
  };
}

/** Factory — returns a handler with the sender closed over so HandlerDeps
 *  doesn't have to carry the dependency on the shared interface. The
 *  apps/workers/src/index.ts caller resolves the sender once at boot. */
export function buildPushDeliverHandler(sender: WebPushSender | null): JobHandler {
  return async function pushDeliverHandler(row, deps) {
    if (!row.target_user_id) {
      throw new Error('push_deliver: target_user_id is required on the job row');
    }

    // No VAPID keys configured → mark skipped and return. Avoids dead-
    // lettering valid rows on a misconfigured env; ops sees the
    // skipped_no_vapid count and re-deploys with keys.
    if (sender === null) {
      await stampDeliveryStatus(deps, row, 'skipped_no_vapid', []);
      deps.logger.warn({
        event: 'push.deliver.skipped_no_vapid',
        jobId: row.id,
        userId: row.target_user_id,
      });
      return;
    }

    // (1) Staleness check. row.created_at is when the trigger inserted this
    // row, which fires in the same UPDATE that flips the source risk_push
    // row to status='done' — within milliseconds of the decision. Skipping
    // anything older than 15 min protects against a delivery backlog turning
    // a 9 PM nudge into an effective 11 PM push (§12 hard rule).
    const now = Date.now();
    const createdMs = Date.parse(row.created_at);
    if (Number.isFinite(createdMs) && now - createdMs > STALENESS_WINDOW_MS) {
      await stampDeliveryStatus(deps, row, 'skipped_stale', []);
      deps.logger.info({
        event: 'push.deliver.skipped_stale',
        jobId: row.id,
        userId: row.target_user_id,
        ageMs: now - createdMs,
      });
      return;
    }

    // (2) Opt-out check. Default-on policy: absent key OR explicit `true`
    // means deliver. Only an explicit `false` opts out.
    const enabled = await isStreakRiskPushEnabled(deps, row.target_user_id);
    if (!enabled) {
      await stampDeliveryStatus(deps, row, 'skipped_opt_out', []);
      deps.logger.info({
        event: 'push.deliver.skipped_opt_out',
        jobId: row.id,
        userId: row.target_user_id,
      });
      return;
    }

    // (3) Subscription lookup. Active = disabled_at is null. Hot-path index
    // user_push_subscriptions_active_by_user covers the predicate.
    const subscriptions = await fetchActiveSubscriptions(deps, row.target_user_id);
    if (subscriptions.length === 0) {
      await stampDeliveryStatus(deps, row, 'skipped_no_subscription', []);
      deps.logger.info({
        event: 'push.deliver.skipped_no_subscription',
        jobId: row.id,
        userId: row.target_user_id,
      });
      return;
    }

    // (4) Build payload. JSON-stringified so the SW can JSON.parse it once.
    const payload = (row.payload ?? {}) as PushDeliverPayload;
    const body = buildNotificationPayload({
      streakLength: numberFrom(payload.current_length, 0),
      progress: numberFrom(payload.progress, 0),
      freezes: numberFrom(payload.freezes, 0),
    });
    const payloadJson = JSON.stringify(body);

    // (5) Per-sub attempt loop. Throwable outcomes (transient 5xx, 429)
    // propagate to the scheduler so it can backoff + retry; non-throwable
    // outcomes (gone, unauthorized, payload_too_large) are recorded per-sub
    // and the loop continues.
    const perSub: PerSubResult[] = [];
    let sentCount = 0;
    let transientErr: { statusCode: number; message: string } | null = null;
    for (const sub of subscriptions) {
      let outcome: SendOutcome;
      try {
        outcome = await sender.send(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          payloadJson,
        );
      } catch (err) {
        // The sender should never throw on a normalized outcome path; if it
        // does, treat as transient. Preserves the retry contract.
        outcome = {
          kind: 'transient',
          statusCode: 0,
          message: truncateMessage(err instanceof Error ? err.message : String(err)),
        };
      }

      switch (outcome.kind) {
        case 'sent':
          await touchLastDelivered(deps, sub.id);
          sentCount += 1;
          perSub.push({ subscription_id: sub.id, outcome: 'sent' });
          break;
        case 'gone':
          await softDeleteSubscription(deps, sub.id, 'gone');
          perSub.push({ subscription_id: sub.id, outcome: 'gone' });
          break;
        case 'unauthorized':
          await softDeleteSubscription(deps, sub.id, 'unauthorized');
          perSub.push({ subscription_id: sub.id, outcome: 'unauthorized' });
          break;
        case 'payload_too_large':
          // Body should never exceed limits given the §4 copy, but record it
          // and continue. A future change to buildNotificationBody could
          // regress this; the log is the canary.
          deps.logger.warn({
            event: 'push.deliver.payload_too_large',
            jobId: row.id,
            subscriptionId: sub.id,
          });
          perSub.push({ subscription_id: sub.id, outcome: 'payload_too_large' });
          break;
        case 'transient': {
          // Capture the first transient error to throw after the loop. We
          // still continue so other subs land before the retry; the row's
          // attempt counter is per-job, not per-sub, so this trades a small
          // amount of duplicate work on retry (sent subs no-op via 410-or-
          // last_delivered_at-touch) for cleaner per-row semantics.
          //
          // Message is truncated before any persistence/log path because
          // it originates from an attacker-influenceable upstream response
          // body — bounded length defends DB / log bloat (security-reviewer
          // ask, 2026-06-15).
          const truncated = truncateMessage(outcome.message);
          if (transientErr === null) {
            transientErr = { statusCode: outcome.statusCode, message: truncated };
          }
          perSub.push({
            subscription_id: sub.id,
            outcome: 'transient',
            statusCode: outcome.statusCode,
            message: truncated,
          });
          break;
        }
      }
    }

    if (transientErr !== null) {
      // Status NOT stamped here — scheduler will retry the whole row.
      throw new Error(
        `push_deliver: transient send failure (${transientErr.statusCode}): ${transientErr.message}`,
      );
    }

    const status: DeliveryStatus =
      sentCount === subscriptions.length ? 'delivered' : sentCount > 0 ? 'partial' : 'failed';
    await stampDeliveryStatus(deps, row, status, perSub);
    deps.logger.info({
      event: 'push.deliver.complete',
      jobId: row.id,
      userId: row.target_user_id,
      status,
      subscriptionsTried: subscriptions.length,
      sent: sentCount,
    });
  };
}

// ---------------------------------------------------------------------------
// DB helpers — keep these in this file to mirror the risk-push handler's
// shape (no separate repository layer for one feature).
// ---------------------------------------------------------------------------

async function isStreakRiskPushEnabled(
  deps: Parameters<JobHandler>[1],
  userId: string,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any)
    .from('users')
    .select('notification_preferences')
    .eq('id', userId)
    .maybeSingle()) as {
    data: { notification_preferences: Record<string, unknown> | null } | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`push_deliver: read prefs: ${error.message}`);
  if (!data) {
    // User row vanished between decision and delivery (deleted account).
    // Treat as opt-out — no notification can reach a deleted user anyway.
    return false;
  }
  const prefs = data.notification_preferences ?? {};
  const raw = (prefs as Record<string, unknown>).streak_risk_push;
  if (raw === undefined || raw === null) return true; // default-on
  return raw !== false;
}

async function fetchActiveSubscriptions(
  deps: Parameters<JobHandler>[1],
  userId: string,
): Promise<SubscriptionRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any)
    .from('user_push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)
    .is('disabled_at', null)) as {
    data: SubscriptionRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`push_deliver: fetch subs: ${error.message}`);
  return data ?? [];
}

async function touchLastDelivered(
  deps: Parameters<JobHandler>[1],
  subscriptionId: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('user_push_subscriptions')
    .update({ last_delivered_at: new Date().toISOString() })
    .eq('id', subscriptionId)) as { error: { message: string } | null };
  if (error) {
    deps.logger.warn({
      event: 'push.deliver.touch_failed',
      subscriptionId,
      message: error.message,
    });
  }
}

async function softDeleteSubscription(
  deps: Parameters<JobHandler>[1],
  subscriptionId: string,
  reason: 'gone' | 'unauthorized',
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('user_push_subscriptions')
    .update({ disabled_at: new Date().toISOString(), disabled_reason: reason })
    .eq('id', subscriptionId)) as { error: { message: string } | null };
  if (error) {
    deps.logger.warn({
      event: 'push.deliver.soft_delete_failed',
      subscriptionId,
      reason,
      message: error.message,
    });
  }
}

async function stampDeliveryStatus(
  deps: Parameters<JobHandler>[1],
  row: ScheduledJobRow,
  status: DeliveryStatus,
  perSub: PerSubResult[],
): Promise<void> {
  const newPayload = {
    ...row.payload,
    delivery_status: status,
    delivered_at: new Date().toISOString(),
    per_sub: perSub,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({ payload: newPayload })
    .eq('id', row.id)) as { error: { message: string } | null };
  if (error) {
    throw new Error(`push_deliver: stamp status (${status}): ${error.message}`);
  }
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Cap upstream-response message length when persisting / logging. The push
// service body is attacker-influenceable in transient-failure scenarios;
// unbounded persistence in scheduled_jobs.payload would be a slow-bloat
// vector (security-reviewer finding, 2026-06-15).
const MAX_MESSAGE_LEN = 200;
function truncateMessage(message: string): string {
  return message.length > MAX_MESSAGE_LEN ? `${message.slice(0, MAX_MESSAGE_LEN)}…` : message;
}

export const __testing = { STALENESS_WINDOW_MS, MAX_MESSAGE_LEN };
