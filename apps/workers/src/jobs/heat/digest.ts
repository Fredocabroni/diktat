// drop_shadow_digest — nightly generator that captures:
//   - the day's real Drop pick (news_topics where is_drop=true, drop_at
//     in the previous 24h),
//   - the top-5 candidates by heat_score at digest time (what the heat
//     composer would have picked),
//   - the weights snapshot in use.
//
// Writes via SECURITY DEFINER RPC `record_drop_shadow_log` (migration
// 20261029000000). Operator pick + notes are filled from the admin
// UI in a follow-up PR via `record_drop_shadow_operator_pick`.
//
// DELIVERY is explicitly deferred — this worker only generates the
// row. See the PR description for the proposed delivery channel.
//
// HEAT_ENABLED gates the generator at the handler level: when the
// composer is off, heat_score is NULL across the board and the
// shadow_top_5 is meaningless. Short-circuit to outcome='disabled'.

import { scrubMessage } from '@diktat/shared/alerts';

import type { Database } from '@diktat/db';

import { loadEnv, type Env } from '../../env.js';
import type { JobHandler, ScheduledJobRow } from '../scheduler.js';
import { DEFAULT_HEAT_WEIGHTS } from './weights.js';

type ScheduledJobsUpdate = Database['public']['Tables']['scheduled_jobs']['Update'];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOP_N = 5;

/** Window the generator scans for candidates. Matches the composer's
 *  48h active window. */
const CANDIDATE_WINDOW_HOURS = 48;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Compute "yesterday's ET date" at the point the digest fires. The
 *  digest fires at 06:00 UTC, by which time the day's Drop (20:00 ET)
 *  has published for the ET-day currently 2–3 hours in the past (00:00
 *  or 01:00 UTC depending on DST). We encode as a UTC date here —
 *  simplest key and good enough for one-row-per-day. The admin UI can
 *  render the ET-day equivalent for operator readability. */
export function digestDate(now: Date): string {
  // Use the UTC date of "now minus 6 hours" so a 06:00 UTC fire pins
  // to that UTC day. For later fires in the same calendar window it
  // still produces the same date; the primary-key upsert handles
  // re-fires idempotently anyway.
  const t = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
    t.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Shape of a single row in the shadow_top_5 jsonb array. */
export interface ShadowTopEntry {
  readonly candidate_id: string;
  readonly source_title: string;
  readonly source_url: string;
  readonly heat_score: number;
  readonly heat_components: Record<string, unknown> | null;
  readonly global_event_id: string | null;
}

export function buildShadowTop5(
  rows: ReadonlyArray<{
    readonly id: string;
    readonly source_title: string | null;
    readonly source_url: string | null;
    readonly heat_score: number | null;
    readonly heat_components: unknown;
    readonly global_event_id: string | null;
  }>,
): ShadowTopEntry[] {
  const out: ShadowTopEntry[] = [];
  for (const r of rows) {
    if (!r.source_title || !r.source_url) continue;
    if (typeof r.heat_score !== 'number' || !Number.isFinite(r.heat_score)) continue;
    out.push({
      candidate_id: r.id,
      source_title: r.source_title,
      source_url: r.source_url,
      heat_score: r.heat_score,
      heat_components:
        r.heat_components && typeof r.heat_components === 'object'
          ? (r.heat_components as Record<string, unknown>)
          : null,
      global_event_id: r.global_event_id,
    });
    if (out.length >= TOP_N) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface StampPayload {
  readonly emitted_at?: string;
  readonly outcome: 'ok' | 'disabled' | 'degraded_db';
  readonly drop_date?: string;
  readonly real_drop_topic_id?: string | null;
  readonly shadow_count?: number;
  readonly reason?: string;
}

function emittedAtFromRow(row: ScheduledJobRow): string | undefined {
  const v = row.payload.emitted_at;
  return typeof v === 'string' ? v : undefined;
}

async function stampPayload(
  deps: Parameters<JobHandler>[1],
  rowId: string,
  payload: StampPayload,
): Promise<void> {
  const update: ScheduledJobsUpdate = {
    payload: payload as unknown as ScheduledJobsUpdate['payload'],
  };
  const { error } = await deps.supabase.from('scheduled_jobs').update(update).eq('id', rowId);
  if (error) {
    deps.logger.debug({
      event: 'drop_shadow_digest.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

export function buildDropShadowDigestHandler(opts?: {
  readonly now?: () => Date;
  readonly envProvider?: () => Env;
}): JobHandler {
  const now = opts?.now ?? (() => new Date());
  const envProvider = opts?.envProvider ?? loadEnv;
  return async function dropShadowDigestHandler(row: ScheduledJobRow, deps): Promise<void> {
    const env = envProvider();
    const startedAt = now();
    const dropDate = digestDate(startedAt);

    if (!env.HEAT_ENABLED) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'disabled',
        drop_date: dropDate,
      });
      deps.logger.info({
        event: 'drop_shadow_digest.disabled',
        jobId: row.id,
        drop_date: dropDate,
      });
      return;
    }

    // 1. Find the real Drop pick in the previous 24h.
    const windowEndIso = startedAt.toISOString();
    const windowStartIso = new Date(startedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: dropRow, error: dropErr } = await deps.supabase
      .from('news_topics')
      .select('id, drop_at')
      .eq('is_drop', true)
      .gt('drop_at', windowStartIso)
      .lte('drop_at', windowEndIso)
      .order('drop_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dropErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        drop_date: dropDate,
        reason: scrubMessage(dropErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'drop_shadow_digest.drop_load_failed',
        message: scrubMessage(dropErr.message),
      });
      return;
    }
    const realDropTopicId = dropRow?.id ?? null;

    // 2. Load top-5 candidates by heat_score within the window.
    const candWindowIso = new Date(
      startedAt.getTime() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const { data: cands, error: candErr } = await deps.supabase
      .from('news_topics_candidates')
      .select('id, source_title, source_url, heat_score, heat_components, global_event_id')
      .not('heat_score', 'is', null)
      .gt('created_at', candWindowIso)
      .order('heat_score', { ascending: false, nullsFirst: false })
      .limit(TOP_N);
    if (candErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        drop_date: dropDate,
        reason: scrubMessage(candErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'drop_shadow_digest.cands_load_failed',
        message: scrubMessage(candErr.message),
      });
      return;
    }
    const top5 = buildShadowTop5(cands ?? []);

    // 3. Record via SECURITY DEFINER RPC. The RPC preserves any
    //    operator pick already recorded for this UTC day.
    type ShadowLogArgs = Database['public']['Functions']['record_drop_shadow_log']['Args'];
    const rpcArgs: ShadowLogArgs = {
      p_drop_date: dropDate,
      p_real_drop_topic_id: realDropTopicId,
      p_shadow_top_5: top5 as unknown as ShadowLogArgs['p_shadow_top_5'],
      p_weights_snapshot: DEFAULT_HEAT_WEIGHTS as unknown as ShadowLogArgs['p_weights_snapshot'],
    };
    const { error: rpcErr } = await deps.supabase.rpc('record_drop_shadow_log', rpcArgs);
    if (rpcErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        drop_date: dropDate,
        reason: scrubMessage(rpcErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'drop_shadow_digest.record_rpc_failed',
        message: scrubMessage(rpcErr.message),
      });
      return;
    }

    await stampPayload(deps, row.id, {
      emitted_at: emittedAtFromRow(row),
      outcome: 'ok',
      drop_date: dropDate,
      real_drop_topic_id: realDropTopicId,
      shadow_count: top5.length,
    });
    deps.logger.info({
      event: 'drop_shadow_digest.complete',
      jobId: row.id,
      drop_date: dropDate,
      real_drop_topic_id: realDropTopicId,
      shadow_count: top5.length,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

export const dropShadowDigestHandler: JobHandler = buildDropShadowDigestHandler();
