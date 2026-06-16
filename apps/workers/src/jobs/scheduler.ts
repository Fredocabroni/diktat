// Scheduler poll consumer. Phase 4 scheduling spine.
//
// Architecture: pg_cron writes idempotent due-rows into public.scheduled_jobs;
// this loop drains them, dispatching by job_type to a handler registry. Until
// a job_type's handler is registered, its rows accumulate untouched -- the
// table is the durable cross-PR contract.
//
// Why this exists (rather than in-process intervals like Phase 3): the Drop's
// "never skip a day" invariant (ADDICTION_ARCHITECTURE §5) requires the
// SOURCE OF TRUTH for "it is time" to live outside the ephemeral workers
// process. pg_cron in the always-on managed DB is that source; this consumer
// is the bridge to Node-side work.
//
// Claim is atomic (FOR UPDATE SKIP LOCKED) via the claim_scheduled_jobs SQL
// function -- Supabase JS cannot express FOR UPDATE, so the function is the
// only safe way to claim under concurrency. Single-instance assumption today;
// the FOR UPDATE SKIP LOCKED makes a multi-instance future safe.
//
// In THIS PR the handler registry has only 'heartbeat' (the end-to-end
// liveness proof). Feature PRs (4.2 Drop, 4.4 streak push, etc.) register
// their own job_types.

import type { invoke as fabricInvoke, ProviderEnv } from '@diktat/ai-fabric';

import { factCheckOrchestratorHandler } from './fact-check-orchestrator.js';
import { localBoundarySweepHandler } from './local-boundary-sweep.js';
import { buildNewsIngestHandler } from './news-ingest.js';
import { buildPushDeliverHandler, type WebPushSender } from './push-deliver.js';
import { riskPushHandler } from './risk-push.js';
import type { ServiceClient } from '../supabase.js';
import type { Logger } from '../logger.js';

/** A row in public.scheduled_jobs as the consumer sees it. */
export interface ScheduledJobRow {
  id: string;
  job_type: string;
  idempotency_key: string;
  target_user_id: string | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Handler contract: process a claimed row. Throw to signal failure -> retry
 *  with backoff, or dead-letter once attempts >= max_attempts. */
export type JobHandler = (row: ScheduledJobRow, deps: HandlerDeps) => Promise<void>;

export interface HandlerDeps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  /** ai-fabric invoke — required by handlers that call AI models
   *  (PR 4.7 fact_check). Optional so existing handlers (heartbeat,
   *  local_boundary_sweep, risk_push) don't have to supply it. */
  readonly invoke?: typeof fabricInvoke;
  /** Provider availability snapshot — required when invoke is. */
  readonly providerEnv?: ProviderEnv;
  /** fetch impl — required by handlers that probe URLs. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface SchedulerDeps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  /** Distinct id for this worker process. Stamped onto locked_by. */
  readonly workerId: string;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly now?: () => Date;
  /** Optional ai-fabric / fetch deps forwarded to handlers that need
   *  them (PR 4.7 fact_check). */
  readonly invoke?: typeof fabricInvoke;
  readonly providerEnv?: ProviderEnv;
  readonly fetch?: typeof globalThis.fetch;
}

/** Tunables. Conservative defaults; not env-driven for now. */
const CLAIM_BATCH = 16;
const STALE_LOCK_MS = 10 * 60 * 1000; // 10 min -- a handler taking >10 min is presumed crashed
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 min ceiling

/** Exponential backoff with a cap; per-attempt. attempts is 1 after the first
 *  failure (claim increments before dispatch), so attempts=1 -> base, 2 -> 2x,
 *  3 -> 4x, capped. */
export function backoffMsFor(attempts: number): number {
  const ms = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(ms, BACKOFF_CAP_MS);
}

export interface TickResult {
  reapedStale: number;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  errors: number;
}

/** Run one scheduler tick: reap stale locks, claim a batch, dispatch each.
 *  Returns counts for observability. */
export async function runSchedulerTick(deps: SchedulerDeps): Promise<TickResult> {
  const result: TickResult = {
    reapedStale: 0,
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    errors: 0,
  };

  // 1. Stale-lock reaper. A row stuck in 'processing' past the stale window
  //    means the previous worker crashed (or a handler hung) -- return it to
  //    'pending' so it can be re-claimed and retried. Idempotent.
  try {
    result.reapedStale = await reapStaleLocks(deps);
  } catch (err) {
    deps.logger.error({
      event: 'scheduler.reap_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    result.errors += 1;
  }

  // 2. Claim a batch atomically via the SQL function.
  let claimed: ScheduledJobRow[] = [];
  try {
    claimed = await claimBatch(deps);
    result.claimed = claimed.length;
  } catch (err) {
    deps.logger.error({
      event: 'scheduler.claim_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    result.errors += 1;
    return result;
  }

  // 3. Dispatch each claimed row to its handler.
  for (const row of claimed) {
    const handler = deps.handlers[row.job_type];
    if (!handler) {
      // Defensive: the claim query filters by registered handler types, so
      // this branch is unreachable in practice. If we ever hit it, mark the
      // row failed (not dead) so it's visible without permanent loss.
      await markRowFailed(deps, row, `no handler for job_type=${row.job_type}`);
      result.errors += 1;
      continue;
    }

    try {
      await handler(row, {
        supabase: deps.supabase,
        logger: deps.logger,
        ...(deps.invoke ? { invoke: deps.invoke } : {}),
        ...(deps.providerEnv ? { providerEnv: deps.providerEnv } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      await markRowDone(deps, row);
      result.succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (row.attempts >= row.max_attempts) {
        await markRowDead(deps, row, message);
        result.deadLettered += 1;
        deps.logger.error({
          event: 'scheduler.dead_letter',
          jobId: row.id,
          jobType: row.job_type,
          attempts: row.attempts,
          message,
        });
      } else {
        const backoffMs = backoffMsFor(row.attempts);
        await markRowRetry(deps, row, message, backoffMs);
        result.retried += 1;
        deps.logger.warn({
          event: 'scheduler.handler_failed',
          jobId: row.id,
          jobType: row.job_type,
          attempts: row.attempts,
          backoffMs,
          message,
        });
      }
    }
  }

  if (result.claimed > 0 || result.reapedStale > 0) {
    deps.logger.info({ event: 'scheduler.tick', ...result });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Row state transitions
// ---------------------------------------------------------------------------

async function reapStaleLocks(deps: SchedulerDeps): Promise<number> {
  const cutoff = new Date(
    (deps.now ?? (() => new Date()))().getTime() - STALE_LOCK_MS,
  ).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (deps.supabase as any).from('scheduled_jobs');
  const { data, error } = (await table
    .update({ status: 'pending', locked_at: null, locked_by: null })
    .eq('status', 'processing')
    .lt('locked_at', cutoff)
    .select('id')) as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`reapStaleLocks: ${error.message}`);
  return data?.length ?? 0;
}

async function claimBatch(deps: SchedulerDeps): Promise<ScheduledJobRow[]> {
  const handlerTypes = Object.keys(deps.handlers);
  if (handlerTypes.length === 0) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any).rpc('claim_scheduled_jobs', {
    p_handler_types: handlerTypes,
    p_limit: CLAIM_BATCH,
    p_worker_id: deps.workerId,
  })) as { data: ScheduledJobRow[] | null; error: { message: string } | null };
  if (error) throw new Error(`claim_scheduled_jobs: ${error.message}`);
  return data ?? [];
}

async function markRowDone(deps: SchedulerDeps, row: ScheduledJobRow): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({
      status: 'done',
      processed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq('id', row.id)) as { error: { message: string } | null };
  if (error) {
    deps.logger.error({
      event: 'scheduler.mark_done_failed',
      jobId: row.id,
      message: error.message,
    });
  }
}

async function markRowRetry(
  deps: SchedulerDeps,
  row: ScheduledJobRow,
  message: string,
  backoffMs: number,
): Promise<void> {
  const availableAt = new Date(Date.now() + backoffMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({
      status: 'pending',
      available_at: availableAt,
      locked_at: null,
      locked_by: null,
      last_error: message,
    })
    .eq('id', row.id)) as { error: { message: string } | null };
  if (error) {
    deps.logger.error({
      event: 'scheduler.mark_retry_failed',
      jobId: row.id,
      message: error.message,
    });
  }
}

async function markRowDead(
  deps: SchedulerDeps,
  row: ScheduledJobRow,
  message: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({
      status: 'dead',
      locked_at: null,
      locked_by: null,
      last_error: message,
      processed_at: new Date().toISOString(),
    })
    .eq('id', row.id)) as { error: { message: string } | null };
  if (error) {
    deps.logger.error({
      event: 'scheduler.mark_dead_failed',
      jobId: row.id,
      message: error.message,
    });
  }
}

async function markRowFailed(
  deps: SchedulerDeps,
  row: ScheduledJobRow,
  message: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({
      status: 'failed',
      locked_at: null,
      locked_by: null,
      last_error: message,
    })
    .eq('id', row.id)) as { error: { message: string } | null };
  if (error) {
    deps.logger.error({
      event: 'scheduler.mark_failed_failed',
      jobId: row.id,
      message: error.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Handler registry. This PR ships exactly one handler: heartbeat.
// ---------------------------------------------------------------------------

/** Heartbeat handler: end-to-end liveness proof. Cron emits a heartbeat row
 *  every 15 min; this handler logs and returns -- the row is marked 'done' by
 *  the dispatcher. Monitoring: newest 'done' heartbeat older than ~20 min
 *  means either pg_cron or this consumer is degraded. */
export const heartbeatHandler: JobHandler = async (row, deps) => {
  deps.logger.info({
    event: 'scheduler.heartbeat',
    jobId: row.id,
    idempotencyKey: row.idempotency_key,
  });
};

/** Default registry of statically-constructed handlers. Use this in tests
 *  that don't exercise push delivery; the boot path uses
 *  buildDefaultHandlers() below to attach the runtime-configured
 *  push_deliver handler. Feature PRs extend it with their own job_types
 *  (drop_publish in PR 4.2, risk_push in PR 4.4, etc.). */
export const defaultHandlers: Readonly<Record<string, JobHandler>> = Object.freeze({
  heartbeat: heartbeatHandler,
  local_boundary_sweep: localBoundarySweepHandler,
  risk_push: riskPushHandler,
  fact_check: factCheckOrchestratorHandler,
  news_ingest: buildNewsIngestHandler(),
});

/** Build the runtime registry. The push_deliver handler is a factory because
 *  it closes over a WebPushSender configured with VAPID keys at boot — those
 *  keys must never leave the workers process. When sender is null (VAPID env
 *  not configured), the handler still claims push_deliver rows but stamps
 *  them as skipped_no_vapid and returns done — keeps the queue draining
 *  cleanly on dev envs without keys. */
export function buildDefaultHandlers(opts: {
  webPushSender: WebPushSender | null;
}): Readonly<Record<string, JobHandler>> {
  return Object.freeze({
    ...defaultHandlers,
    push_deliver: buildPushDeliverHandler(opts.webPushSender),
  });
}

export const __testing = { backoffMsFor, CLAIM_BATCH, STALE_LOCK_MS };
