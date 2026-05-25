// risk_push handler. Fires at each user's local 21:00–21:14 window
// (one row per user per local day, idempotent via the partial-unique
// index on scheduled_jobs).
//
// Calls the public.evaluate_risk_push(uuid, date) SQL function — a
// read-only decision evaluator. PR 4.4 ships the DECISION and
// SCHEDULING logic only. Actual web-push DELIVERY is deferred to the
// future web-push PR, which will walk scheduled_jobs rows where
//   job_type = 'risk_push'
//   status   = 'done'
//   payload->>'decision' = 'would_push'
// in a recent time window and dispatch via whichever push service.
//
// Why this split: the decision is the ethical surface (when do we
// nudge a user?). It lives close to streak state, where the rules are
// readable and auditable. Delivery is plumbing; it ships separately
// when the push-channel SDK + opt-out preference shape are settled.
//
// ADDICTION compliance enforced here:
//   - 9 PM local only (cron predicate, not this handler)
//   - skip when current_length = 0 (SQL fn returns skip_no_streak)
//   - skip when Take 5 already complete (SQL fn returns skip_completed)
//   - re-verified at handler time (state may have changed in the 15-min
//     window between cron tick and handler claim)

import type { JobHandler } from './scheduler.js';

interface RiskPushPayload {
  readonly local_date?: string;
  readonly user_tz?: string;
  readonly emitted_at_local?: string;
}

type Decision = 'would_push' | 'skip_completed' | 'skip_no_streak';

interface RiskPushRpcResult {
  readonly decision: Decision;
  readonly current_length?: number;
  readonly progress?: number;
  readonly freezes?: number;
  readonly freezes_max?: number;
}

export const riskPushHandler: JobHandler = async (row, deps) => {
  if (!row.target_user_id) {
    throw new Error('risk_push: target_user_id is required on the job row');
  }
  const payload = (row.payload ?? {}) as RiskPushPayload;
  if (typeof payload.local_date !== 'string' || payload.local_date.length === 0) {
    throw new Error(
      `risk_push: payload.local_date is required (got ${JSON.stringify(payload.local_date)})`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any).rpc('evaluate_risk_push', {
    p_user_id: row.target_user_id,
    p_local_date: payload.local_date,
  })) as { data: RiskPushRpcResult | null; error: { message: string } | null };

  if (error) {
    throw new Error(`evaluate_risk_push RPC failed: ${error.message}`);
  }
  const result = data ?? { decision: 'skip_no_streak' as const };

  // Stamp the decision into the row's payload so the future web-push PR
  // can consume the trail. The dispatcher (markRowDone) will then flip
  // status to 'done' without touching payload.
  const newPayload = {
    ...row.payload,
    decision: result.decision,
    evaluated_at: new Date().toISOString(),
    current_length: result.current_length ?? null,
    progress: result.progress ?? null,
    freezes: result.freezes ?? null,
    freezes_max: result.freezes_max ?? null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateErr } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({ payload: newPayload })
    .eq('id', row.id)) as { error: { message: string } | null };
  if (updateErr) {
    throw new Error(`risk_push: failed to stamp decision into payload: ${updateErr.message}`);
  }

  deps.logger.info({
    event: 'streak.risk_push_evaluated',
    jobId: row.id,
    userId: row.target_user_id,
    localDate: payload.local_date,
    decision: result.decision,
    currentLength: result.current_length ?? null,
    progress: result.progress ?? null,
    freezes: result.freezes ?? null,
  });
};
