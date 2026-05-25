// local_boundary_sweep handler. Fires at each user's local 00:00–00:14
// window (one row per user per local day, idempotent via the partial-
// unique index on scheduled_jobs).
//
// Calls the public.apply_local_boundary_sweep(uuid, date) SQL function
// — the atomic write boundary that advances / freeze-rescues / breaks
// the user's streak. The handler is a thin RPC bridge:
//   - Validate target_user_id + payload.yesterday from the row
//   - Invoke the RPC
//   - Log the outcome
//   - Throw on RPC error so the scheduler's exponential backoff retries
//
// Streak break is silent — this handler does NOT emit any push or
// downstream signal on outcome='broken'. That is the ADDICTION §11.5
// contract (no "you missed it" notifications).

import type { JobHandler } from './scheduler.js';

interface SweepPayload {
  readonly yesterday?: string;
  readonly user_tz?: string;
  readonly emitted_at_local?: string;
}

interface SweepRpcResult {
  readonly outcome: 'advanced' | 'frozen' | 'broken' | 'already_swept' | 'streak_not_found';
  readonly new_length?: number;
  readonly freezes?: number;
  readonly milestone_granted?: boolean;
}

export const localBoundarySweepHandler: JobHandler = async (row, deps) => {
  if (!row.target_user_id) {
    throw new Error('local_boundary_sweep: target_user_id is required on the job row');
  }
  const payload = (row.payload ?? {}) as SweepPayload;
  if (typeof payload.yesterday !== 'string' || payload.yesterday.length === 0) {
    throw new Error(
      `local_boundary_sweep: payload.yesterday is required (got ${JSON.stringify(payload.yesterday)})`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any).rpc('apply_local_boundary_sweep', {
    p_user_id: row.target_user_id,
    p_yesterday: payload.yesterday,
  })) as { data: SweepRpcResult | null; error: { message: string } | null };

  if (error) {
    throw new Error(`apply_local_boundary_sweep RPC failed: ${error.message}`);
  }
  const result = data ?? { outcome: 'streak_not_found' as const };

  deps.logger.info({
    event: 'streak.boundary_sweep',
    jobId: row.id,
    userId: row.target_user_id,
    yesterday: payload.yesterday,
    userTz: payload.user_tz ?? null,
    outcome: result.outcome,
    newLength: result.new_length ?? null,
    freezes: result.freezes ?? null,
    milestoneGranted: result.milestone_granted ?? false,
  });
};
