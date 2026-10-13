// gdelt_event_retention — 24h sweep of the GDELT rolling-window
// cluster state (migration 20261016000000). pg_cron ticks this
// `job_type` every 15 minutes alongside the news-ingest spine.
//
// What it does: DELETE from public.gdelt_event_cluster where
// last_seen_at < now() - interval '24 hours'. The outlet detail
// table drops via ON DELETE CASCADE. drop_published_at rows are
// NOT special-cased — once a Drop has sourced from a cluster, the
// cluster row is retained only as long as mentions keep refreshing
// last_seen_at. After 24h of silence, the aggregate is garbage.
//
// Safety: this is a bounded DELETE on an internal pipeline table.
// No RLS traversal, no economy effect, no AI spend. One-shot per
// tick, idempotent — a double-fire deletes the same (empty) set.
//
// Throws on error so the scheduler marks the row 'failed' and
// retries with backoff.

import { scrubMessage } from '@diktat/shared/alerts';

import type { JobHandler } from './scheduler.js';

/** How far back we retain cluster rows. Operator decision 2026-10-13:
 *  24 hours. Rolling-window S3 balance checks don't need older data —
 *  by the time a cluster goes dark for 24h, either a Drop has been
 *  sourced (and the aggregate did its job) or no Drop will ever
 *  source from it (and it's garbage). */
export const GDELT_CLUSTER_RETENTION_HOURS = 24;

export const gdeltEventRetentionHandler: JobHandler = async (_row, deps) => {
  const cutoff = new Date(Date.now() - GDELT_CLUSTER_RETENTION_HOURS * 3600 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error, count } = (await (deps.supabase as any)
    .from('gdelt_event_cluster')
    .delete({ count: 'exact' })
    .lt('last_seen_at', cutoff)) as { error: { message: string } | null; count: number | null };

  if (error) {
    throw new Error(`gdelt_event_retention: delete failed: ${scrubMessage(error.message)}`);
  }

  deps.logger.info({
    event: 'gdelt_event_retention.swept',
    cutoff,
    deleted: count ?? 0,
    retention_hours: GDELT_CLUSTER_RETENTION_HOURS,
  });
};
