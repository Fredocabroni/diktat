// heat_compose — scheduler-spine worker that computes per-candidate
// heat_score from matched trend_signals + the GDELT distinct-outlet
// count. Writes `heat_score` + `heat_components` to
// public.news_topics_candidates (migration 20261101000000; the
// 20261028 timestamp originally queued for this feature was
// renumbered forward when 20261024/20261025/20261030 landed first).
//
// SHADOW ONLY. HEAT_ENABLED=false by default. The walker's Drop-
// selection logic never reads these columns in this PR; the flip
// is a separate plan v3 PR gated on P4 landing.
//
// Formula (shadow starting weights in weights.ts; refit after
// nightly digest run):
//
//   age_hours   = (now − cluster.last_seen_at) / 1h
//   decay       = exp(−age_hours / half_life_hours)         // 12h
//   gdelt_term  = w_g   * log(1 + distinct_outlets)
//   google_term = w_gt  * log(1 + max approx_traffic matched)
//   x_term      = w_x   * log(1 + x_signal)                 // vol OR presence
//   bsky_term   = w_bsk * (bsky_matched ? 1 : 0)
//   reddit_term = w_r   * log(1 + Σ score*ratio)            // w_r=0 until approval
//   cross_bonus = w_cross if ≥ cross_bonus_threshold distinct sources matched
//   heat_score  = (sum of terms + cross_bonus) * decay
//
// The composer only reads matched trend_signals (global_event_id
// is not null). Unmatched signals contribute nothing — the matcher
// is responsible for attaching them first.

import { scrubMessage } from '@diktat/shared/alerts';

import type { Database } from '@diktat/db';

import { loadEnv, type Env } from '../../env.js';
import type { JobHandler, ScheduledJobRow } from '../scheduler.js';
import { DEFAULT_HEAT_WEIGHTS, type HeatWeights } from './weights.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window: the composer only scores candidates created
 *  recently enough that they could still become a Drop. Matches
 *  news-dedup-rank's 48h window. */
const CANDIDATE_WINDOW_HOURS = 48;

/** Per-tick batch cap. Protects the loop against a backlog spike. */
const MAX_CANDIDATES_PER_TICK = 500;

/** Cap on the number of distinct cluster IDs passed into the three
 *  downstream `.in(...)` queries. 500 UUIDs in a single `.in(...)`
 *  can serialise past PostgREST's comfortable query-string budget
 *  (~8 KB per request). We dedupe candidate.global_event_id first,
 *  so this is only a cap on *distinct* clusters — a tick that scans
 *  500 candidates with only 50 distinct clusters is unaffected.
 *  Covers the CI security-reviewer LOW on #255. */
const MAX_CLUSTER_IDS_PER_TICK = 200;

type CandidateUpdate = Database['public']['Tables']['news_topics_candidates']['Update'];
type ScheduledJobsUpdate = Database['public']['Tables']['scheduled_jobs']['Update'];
type TrendSignalSource = Database['public']['Enums']['trend_signal_source'];

// ---------------------------------------------------------------------------
// Pure math — exported for tests
// ---------------------------------------------------------------------------

export interface MatchedSignal {
  readonly source: TrendSignalSource;
  readonly payload: Record<string, unknown>;
}

export interface HeatComponents {
  readonly gdelt_term: number;
  readonly reddit_term: number;
  readonly google_term: number;
  readonly x_term: number;
  readonly bsky_term: number;
  readonly cross_bonus: number;
  readonly decay: number;
  readonly matched_sources: number;
  readonly weights: HeatWeights;
  readonly computed_at: string;
}

/** Exponential half-life decay: `0.5^(age_hours / half_life_hours)`.
 *  At age = half_life → 0.5, 2× → 0.25, 3× → 0.125, etc. Caps at 1.0
 *  for future-dated clusters (shouldn't happen but defensive). */
export function decayFactor(ageHours: number, halfLifeHours: number): number {
  if (ageHours <= 0) return 1.0;
  return Math.pow(0.5, ageHours / halfLifeHours);
}

function reduceReddit(signals: ReadonlyArray<MatchedSignal>): number {
  let total = 0;
  for (const s of signals) {
    if (s.source !== 'reddit') continue;
    const p = s.payload as { score?: unknown; upvote_ratio?: unknown };
    const score = typeof p.score === 'number' && Number.isFinite(p.score) ? p.score : 0;
    const ratio =
      typeof p.upvote_ratio === 'number' && Number.isFinite(p.upvote_ratio) ? p.upvote_ratio : 0;
    total += Math.max(0, score) * Math.max(0, Math.min(1, ratio));
  }
  return total;
}

function reduceGoogleApproxTraffic(signals: ReadonlyArray<MatchedSignal>): number {
  let best = 0;
  for (const s of signals) {
    if (s.source !== 'google_trends') continue;
    const p = s.payload as { approx_traffic?: unknown };
    const v = p.approx_traffic;
    if (typeof v === 'number' && Number.isFinite(v) && v > best) best = v;
  }
  return best;
}

function reduceXSignal(signals: ReadonlyArray<MatchedSignal>): number {
  // Prefer tweet_volume (sum across matched X trends). If every X
  // signal is volume-less, fall back to presence count.
  let totalVolume = 0;
  let presence = 0;
  let haveVolume = false;
  for (const s of signals) {
    if (s.source !== 'x_trends') continue;
    presence += 1;
    const p = s.payload as { tweet_volume?: unknown };
    const v = p.tweet_volume;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      haveVolume = true;
      totalVolume += v;
    }
  }
  return haveVolume ? totalVolume : presence;
}

function hasBlueskyMatch(signals: ReadonlyArray<MatchedSignal>): boolean {
  return signals.some((s) => s.source === 'bluesky');
}

function distinctMatchedSources(signals: ReadonlyArray<MatchedSignal>): number {
  const seen = new Set<TrendSignalSource>();
  for (const s of signals) {
    // Wikimedia is validation-only — never contributes to heat.
    if (s.source === 'wikimedia_pageviews') continue;
    // Degrade sentinels don't count as a "matched source."
    if ((s.payload as { degraded?: unknown }).degraded === true) continue;
    seen.add(s.source);
  }
  return seen.size;
}

export interface ComputeInput {
  readonly cluster: {
    readonly distinct_outlets: number;
    readonly last_seen_at_ms: number;
  };
  readonly signals: ReadonlyArray<MatchedSignal>;
  readonly nowMs: number;
  readonly weights?: HeatWeights;
}

export interface ComputeResult {
  readonly heat_score: number;
  readonly components: HeatComponents;
}

/** Pure heat computation. Returns a HeatComponents snapshot alongside
 *  the scalar score. Exported for tests. */
export function computeHeat(input: ComputeInput): ComputeResult {
  const w = input.weights ?? DEFAULT_HEAT_WEIGHTS;
  const ageHours = Math.max(0, (input.nowMs - input.cluster.last_seen_at_ms) / (60 * 60 * 1000));
  const decay = decayFactor(ageHours, w.half_life_hours);

  const gdelt_term = w.w_g * Math.log1p(Math.max(0, input.cluster.distinct_outlets));
  const reddit_term = w.w_r * Math.log1p(reduceReddit(input.signals));
  const google_term = w.w_gt * Math.log1p(reduceGoogleApproxTraffic(input.signals));
  const x_term = w.w_x * Math.log1p(reduceXSignal(input.signals));
  const bsky_term = w.w_bsk * (hasBlueskyMatch(input.signals) ? 1 : 0);
  const matched_sources = distinctMatchedSources(input.signals);
  const cross_bonus = matched_sources >= w.cross_bonus_threshold ? w.w_cross : 0;

  const raw = gdelt_term + reddit_term + google_term + x_term + bsky_term + cross_bonus;
  const heat_score = raw * decay;

  const components: HeatComponents = {
    gdelt_term,
    reddit_term,
    google_term,
    x_term,
    bsky_term,
    cross_bonus,
    decay,
    matched_sources,
    weights: w,
    computed_at: new Date(input.nowMs).toISOString(),
  };
  return { heat_score, components };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface StampPayload {
  readonly emitted_at?: string;
  readonly outcome: 'ok' | 'disabled' | 'degraded_db';
  readonly scanned?: number;
  readonly scored?: number;
  readonly skipped_no_cluster?: number;
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
      event: 'heat_compose.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

export function buildHeatComposeHandler(opts?: {
  readonly now?: () => Date;
  readonly envProvider?: () => Env;
  readonly weights?: HeatWeights;
}): JobHandler {
  const now = opts?.now ?? (() => new Date());
  const envProvider = opts?.envProvider ?? loadEnv;
  const weights = opts?.weights ?? DEFAULT_HEAT_WEIGHTS;
  return async function heatComposeHandler(row: ScheduledJobRow, deps): Promise<void> {
    const env = envProvider();
    const startedAt = now();

    // Composer is itself behind HEAT_ENABLED (not just the walker).
    // When off, the job completes with outcome='disabled' and the
    // existing rank_score path remains authoritative. Operator flips
    // HEAT_ENABLED=true after P4 lands and the shadow digest is
    // calibrated.
    if (!env.HEAT_ENABLED) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'disabled',
      });
      deps.logger.info({ event: 'heat_compose.disabled', jobId: row.id });
      return;
    }

    const windowStartIso = new Date(
      startedAt.getTime() - CANDIDATE_WINDOW_HOURS * 3600 * 1000,
    ).toISOString();

    // 1. Load unscored candidates in the active window.
    const { data: cands, error: candErr } = await deps.supabase
      .from('news_topics_candidates')
      .select('id, global_event_id, created_at')
      .is('heat_score', null)
      .gt('created_at', windowStartIso)
      .order('created_at', { ascending: false })
      .limit(MAX_CANDIDATES_PER_TICK);
    if (candErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        reason: scrubMessage(candErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'heat_compose.candidates_load_failed',
        message: scrubMessage(candErr.message),
      });
      return;
    }
    const candidates = cands ?? [];
    if (candidates.length === 0) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'ok',
        scanned: 0,
        scored: 0,
        skipped_no_cluster: 0,
      });
      deps.logger.info({ event: 'heat_compose.complete', jobId: row.id, scanned: 0, scored: 0 });
      return;
    }

    // 2. Load clusters for these candidates (where global_event_id is
    //    non-null — primary-source candidates stay heat-less because
    //    their value is already in the rank_score path). Distinct
    //    cluster set is capped so the downstream `.in(...)` queries
    //    don't exceed PostgREST's query-string budget — see
    //    MAX_CLUSTER_IDS_PER_TICK. Overflow is logged + processed on
    //    the next tick; the composer is idempotent so no row is lost.
    const allClusterIds = Array.from(
      new Set(candidates.map((c) => c.global_event_id).filter((v): v is string => v !== null)),
    );
    const clusterIds = allClusterIds.slice(0, MAX_CLUSTER_IDS_PER_TICK);
    if (allClusterIds.length > MAX_CLUSTER_IDS_PER_TICK) {
      deps.logger.warn({
        event: 'heat_compose.cluster_ids_capped',
        distinct_cluster_ids: allClusterIds.length,
        cap: MAX_CLUSTER_IDS_PER_TICK,
        note: 'overflow processed on next tick',
      });
    }
    const clustersByGid = new Map<string, { last_seen_at_ms: number; distinct_outlets: number }>();
    if (clusterIds.length > 0) {
      const { data: clusters, error: clErr } = await deps.supabase
        .from('gdelt_event_cluster')
        .select('global_event_id, last_seen_at')
        .in('global_event_id', clusterIds);
      if (clErr) {
        await stampPayload(deps, row.id, {
          emitted_at: emittedAtFromRow(row),
          outcome: 'degraded_db',
          reason: scrubMessage(clErr.message).slice(0, 256),
        });
        deps.logger.warn({
          event: 'heat_compose.clusters_load_failed',
          message: scrubMessage(clErr.message),
        });
        return;
      }
      // Count distinct outlets per cluster.
      const { data: outlets, error: outErr } = await deps.supabase
        .from('gdelt_event_cluster_outlet')
        .select('global_event_id, host')
        .in('global_event_id', clusterIds);
      if (outErr) {
        await stampPayload(deps, row.id, {
          emitted_at: emittedAtFromRow(row),
          outcome: 'degraded_db',
          reason: scrubMessage(outErr.message).slice(0, 256),
        });
        return;
      }
      const outletsByGid = new Map<string, Set<string>>();
      for (const o of outlets ?? []) {
        if (!o.global_event_id || !o.host) continue;
        const s = outletsByGid.get(o.global_event_id) ?? new Set<string>();
        s.add(o.host);
        outletsByGid.set(o.global_event_id, s);
      }
      for (const c of clusters ?? []) {
        if (!c.global_event_id || !c.last_seen_at) continue;
        clustersByGid.set(c.global_event_id, {
          last_seen_at_ms: Date.parse(c.last_seen_at),
          distinct_outlets: outletsByGid.get(c.global_event_id)?.size ?? 0,
        });
      }
    }

    // 3. Load matched signals for these clusters.
    const signalsByGid = new Map<string, MatchedSignal[]>();
    if (clusterIds.length > 0) {
      const { data: signals, error: sigErr } = await deps.supabase
        .from('trend_signals')
        .select('global_event_id, source, payload')
        .in('global_event_id', clusterIds);
      if (sigErr) {
        await stampPayload(deps, row.id, {
          emitted_at: emittedAtFromRow(row),
          outcome: 'degraded_db',
          reason: scrubMessage(sigErr.message).slice(0, 256),
        });
        return;
      }
      for (const s of signals ?? []) {
        if (!s.global_event_id) continue;
        const arr = signalsByGid.get(s.global_event_id) ?? [];
        arr.push({
          source: s.source,
          payload: (s.payload ?? {}) as Record<string, unknown>,
        });
        signalsByGid.set(s.global_event_id, arr);
      }
    }

    // 4. For each candidate, compute + write.
    const nowMs = startedAt.getTime();
    let scored = 0;
    let skipped = 0;
    for (const c of candidates) {
      if (!c.global_event_id) {
        skipped += 1;
        continue;
      }
      const cluster = clustersByGid.get(c.global_event_id);
      if (!cluster) {
        skipped += 1;
        continue;
      }
      const signals = signalsByGid.get(c.global_event_id) ?? [];
      const { heat_score, components } = computeHeat({
        cluster: {
          distinct_outlets: cluster.distinct_outlets,
          last_seen_at_ms: cluster.last_seen_at_ms,
        },
        signals,
        nowMs,
        weights,
      });
      // Defensive guard: never persist NaN / ±Infinity to heat_score.
      // computeHeat's inputs are bounded (log1p of non-negative counts
      // + bounded weights) so this is unreachable today, but a future
      // weight edit or an upstream signal shape change that produces
      // non-finite math would otherwise silently poison the ranking
      // column — numeric_jsonb columns accept the SQL `nan` token.
      if (!Number.isFinite(heat_score)) {
        deps.logger.warn({
          event: 'heat_compose.non_finite_score',
          candidate_id: c.id,
          global_event_id: c.global_event_id,
          heat_score,
        });
        skipped += 1;
        continue;
      }
      const update: CandidateUpdate = {
        heat_score,
        heat_components: components as unknown as CandidateUpdate['heat_components'],
      };
      const { error: updErr } = await deps.supabase
        .from('news_topics_candidates')
        .update(update)
        .eq('id', c.id)
        .is('heat_score', null);
      if (updErr) {
        deps.logger.warn({
          event: 'heat_compose.update_failed',
          candidate_id: c.id,
          message: scrubMessage(updErr.message),
        });
        continue;
      }
      scored += 1;
    }

    await stampPayload(deps, row.id, {
      emitted_at: emittedAtFromRow(row),
      outcome: 'ok',
      scanned: candidates.length,
      scored,
      skipped_no_cluster: skipped,
    });
    deps.logger.info({
      event: 'heat_compose.complete',
      jobId: row.id,
      scanned: candidates.length,
      scored,
      skipped_no_cluster: skipped,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

export const heatComposeHandler: JobHandler = buildHeatComposeHandler();
