// pnpm --filter=@diktat/workers factcheck:recheck
//
// Sweeps `fact_check_verdicts` for latest-per-claim rows where
//   authoritative = false AND verdict IN ('supported', 'refuted')
// and enqueues a fresh `scheduled_jobs(job_type='fact_check')` row for
// each with `payload.force_miss=true`. The orchestrator passes that
// flag to `fact_check_dedup_lookup(p_force_miss=>true)` so the stale
// Sonnet-from-memory verdict does NOT short-circuit the fresh
// Perplexity-grounded redo.
//
// Writes NOTHING to `fact_check_verdicts` directly. Enqueues jobs and
// prints a report; the scheduler + orchestrator do the actual AI call
// in-process on the normal spine.
//
// NEVER bypasses the sourced_factcheck per-task daily cap. Each
// re-enqueued claim runs through `assertUnderCap` inside the fabric
// invoke path the orchestrator uses — if the sweep would exceed the
// $50 daily cap, the fabric throws BudgetExceededError and the
// scheduler retries later within the next budget window.
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.
//
// Exit: 0 on success (including "no rows to recheck"). Non-zero on a
// DB error.

import { loadEnv } from '../src/env.js';
import { buildServiceClient } from '../src/supabase.js';

const SWEEP_LIMIT = 500;

interface SweepRow {
  readonly claim_id: string;
  readonly verdict_id: string;
  readonly verdict: 'supported' | 'refuted';
  readonly settled_at: string;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const client = buildServiceClient(env);

  // Latest-per-claim where authoritative=false AND verdict in
  // (supported, refuted). The partial index on
  // (settled_at desc) WHERE authoritative=false AND verdict IN (...)
  // means this scans only the recheck target set — tiny.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (client as any).rpc('fact_check_recheck_sweep', {
    p_limit: SWEEP_LIMIT,
  })) as { data: SweepRow[] | null; error: { message: string } | null };

  // The RPC above is optional — if it does not exist, fall back to a
  // raw SELECT. (The current migration set does not add it; a future
  // follow-up could.) Here we accept either shape.
  let rows: SweepRow[];
  if (error) {
    // No RPC present — do the SELECT the service-role client is
    // allowed to run directly.
    const fallback = await client
      .from('fact_check_verdicts')
      .select('id, claim_id, verdict, settled_at, authoritative')
      .eq('authoritative', false)
      .in('verdict', ['supported', 'refuted'])
      .order('settled_at', { ascending: false })
      .limit(SWEEP_LIMIT);
    if (fallback.error) {
      console.error(`factcheck:recheck — failed to load verdicts: ${fallback.error.message}`);
      process.exit(1);
    }
    const latestByClaim = new Map<string, SweepRow>();
    for (const r of fallback.data ?? []) {
      if (!latestByClaim.has(r.claim_id as string)) {
        latestByClaim.set(r.claim_id as string, {
          claim_id: r.claim_id as string,
          verdict_id: r.id as string,
          verdict: r.verdict as 'supported' | 'refuted',
          settled_at: r.settled_at as string,
        });
      }
    }
    rows = Array.from(latestByClaim.values());
  } else {
    rows = data ?? [];
  }

  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('factcheck:recheck — no non-authoritative supported/refuted verdicts.');
    return;
  }

  // Enqueue a scheduled_jobs row per claim. force_miss=true tells the
  // orchestrator to bypass the dedup cache.
  const now = new Date().toISOString();
  const jobs = rows.map((r) => ({
    job_type: 'fact_check',
    // Deterministic idempotency: a second sweep that picks up the same
    // verdict_id before the first recheck has settled is a no-op at
    // insert time (unique index), so the sweep is safe to re-run.
    idempotency_key: `fact_check:recheck:${r.verdict_id}`,
    status: 'pending' as const,
    available_at: now,
    payload: {
      claim_id: r.claim_id,
      force_miss: true,
      enqueued_by: 'factcheck:recheck',
      prior_verdict_id: r.verdict_id,
      prior_verdict: r.verdict,
      prior_settled_at: r.settled_at,
    },
  }));

  const insert = await client.from('scheduled_jobs').insert(jobs).select('id');
  if (insert.error) {
    console.error(`factcheck:recheck — enqueue failed: ${insert.error.message}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `factcheck:recheck — enqueued ${String((insert.data ?? []).length)} ` +
      `scheduled_jobs row${(insert.data ?? []).length === 1 ? '' : 's'} ` +
      `(claims with authoritative=false AND verdict IN ('supported','refuted')).`,
  );
  // eslint-disable-next-line no-console
  console.log(
    'The scheduler will dispatch each on its normal cadence; the sourced_factcheck ' +
      '$50/day cost cap applies to the whole batch.',
  );
}

main().catch((err: unknown) => {
  console.error(
    `factcheck:recheck — unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
