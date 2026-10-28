// data_minimization_sweep handler. Fires daily at 03:00 UTC via the
// pg_cron entry created in migration 20261113000000. Dispatches to
// the SECURITY DEFINER `data_minimization_sweep(boolean)` RPC with
// the dry-run flag read from the row's payload (default true).
//
// Deletion policy (migration 20261113000000):
//   - Age-blocked accounts (<18 attested) older than 7 days.
//   - Pre-launch human accounts created before 2026-10-21 that never
//     attested, 30 days after launch.
//   - Bots excluded.
//
// Shipping posture: DRY RUN ON. The RPC returns candidate counts; the
// handler logs them. Flip to live by editing the pg_cron payload or
// inserting a one-shot scheduled_jobs row with `{dry_run: false}`.
//
// Error posture: the handler re-throws RPC errors so the scheduler's
// exponential backoff retries. A dry-run RPC call that returns 0
// candidates is still a successful tick — the daily log line is the
// observable signal.

import { scrubMessage } from '@diktat/shared/alerts';

import type { JobHandler } from './scheduler.js';

interface SweepPayload {
  readonly dry_run?: boolean;
}

interface SweepRpcResult {
  readonly dry_run: boolean;
  readonly blocked_candidates: number;
  readonly pre_launch_candidates: number;
  readonly deleted_blocked: number;
  readonly deleted_pre_launch: number;
  // Dry-run: candidate UUIDs the sweep WOULD delete (capped 500 each).
  // Live-run: UUIDs the sweep actually deleted (same cap).
  // Added in migration 20261114000000.
  readonly blocked_candidate_ids: readonly string[];
  readonly pre_launch_candidate_ids: readonly string[];
  // Age-block tombstone bookkeeping. Added in migration 20261115000000.
  // tombstones_written: email-hash rows written on this live age-blocked
  //   purge. Always 0 on dry-run and on pre-launch-only ticks.
  // tombstones_expired: expired rows deleted at the top of the function
  //   on this tick, both dry-run and live.
  readonly tombstones_written?: number;
  readonly tombstones_expired?: number;
  // Provider-identity tombstone bookkeeping. Added in migration
  // 20261120000000. One row per auth.identities row per victim on the
  // live age-blocked purge. Expired-row cleanup runs on every tick.
  readonly identity_tombstones_written?: number;
  readonly identity_tombstones_expired?: number;
  readonly launch_date: string;
  readonly swept_at: string;
}

export const dataMinimizationSweepHandler: JobHandler = async (row, deps) => {
  const payload = (row.payload ?? {}) as SweepPayload;
  // Default to dry-run when the payload omits the flag. Explicit
  // false is required to perform the DELETE — never infer live-run
  // from an unset payload.
  const dryRun = payload.dry_run !== false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any).rpc('data_minimization_sweep', {
    p_dry_run: dryRun,
  })) as { data: SweepRpcResult | null; error: { message: string } | null };

  if (error) {
    throw new Error(`data_minimization_sweep RPC failed: ${scrubMessage(error.message)}`);
  }
  const result = data;
  if (!result) {
    throw new Error('data_minimization_sweep RPC returned null result');
  }

  // Defend against a legacy RPC version that pre-dates migration
  // 20261114000000 (candidate arrays) or 20261115000000 (tombstone
  // counts) and omits those keys — treat missing arrays as empty and
  // missing counts as 0 so the log line still renders.
  const blockedIds = result.blocked_candidate_ids ?? [];
  const preLaunchIds = result.pre_launch_candidate_ids ?? [];
  const tombstonesWritten = result.tombstones_written ?? 0;
  const tombstonesExpired = result.tombstones_expired ?? 0;
  const identityTombstonesWritten = result.identity_tombstones_written ?? 0;
  const identityTombstonesExpired = result.identity_tombstones_expired ?? 0;

  deps.logger.info({
    event: 'data_minimization.sweep',
    jobId: row.id,
    dryRun: result.dry_run,
    blockedCandidates: result.blocked_candidates,
    preLaunchCandidates: result.pre_launch_candidates,
    deletedBlocked: result.deleted_blocked,
    deletedPreLaunch: result.deleted_pre_launch,
    blockedCandidateIds: blockedIds,
    blockedCandidateIdsLength: blockedIds.length,
    preLaunchCandidateIds: preLaunchIds,
    preLaunchCandidateIdsLength: preLaunchIds.length,
    tombstonesWritten,
    tombstonesExpired,
    identityTombstonesWritten,
    identityTombstonesExpired,
    launchDate: result.launch_date,
    sweptAt: result.swept_at,
  });
};
