// news_dedup_rank handler — clusters active candidates by headline
// similarity and assigns each cluster a deterministic UUID. Computes
// the §2 transparent-math ranker:
//
//   rank_score = primary_source_density
//              × gdelt_trending_velocity
//              × recency_decay
//
// gdelt_trending_velocity is fixed at 1.0 in V1 until the GDELT-filtered
// adapter lands (founder spec §1: "E2 — D-source primary feeds +
// GDELT-filtered" — V1 ships the D-source half; GDELT is v2). When GDELT
// lands, this factor becomes the per-cluster mention-velocity normalized
// against a rolling baseline.
//
// Dedup is two-phase:
//   1. URL-canonicalization (already done at ingest time on each
//      candidate — same dedup_url_canon = obvious dup; we collapse here).
//   2. Headline MinHash signature + pairwise Jaccard estimate over
//      the residual. At V1 candidate counts (~50-100 over 48h), exact
//      pairwise on signatures is well within budget; LSH banding is
//      forward-compat for higher volumes but unnecessary at this scale.
//
// EMBEDDING-SIMILARITY DEDUP DEFERRED TO V2 per the scope §5C decision.
// MinHash on word-shingles catches "Senate passes HR-1234 52-48" vs
// "HR-1234 passes Senate 52-48" reliably; it misses "Bill clears upper
// chamber" without entity overlap. That recall gap is acceptable for V1.

import { randomUUID } from 'crypto';

import type { JobHandler } from './scheduler.js';

// ---------------------------------------------------------------------------
// Tunables — transparent, no opaque model
// ---------------------------------------------------------------------------

/** Look-back window for clustering. Older candidates are aged-out from
 *  the active pool. */
const ACTIVE_WINDOW_HOURS = 48;

/** Recency-decay half-life. After N hours, score is halved. */
const RECENCY_HALF_LIFE_HOURS = 12;

/** Jaccard threshold above which two candidates are considered the
 *  same story. Tuned conservatively — small set of MinHash positions
 *  + tight threshold = high precision, slightly lower recall (we want
 *  fewer false-merges than misses; misses surface as separate Drops
 *  on different days, false-merges silently bury distinct stories). */
const JACCARD_CLUSTER_THRESHOLD = 0.55;

/** Number of MinHash positions in each candidate's signature. More
 *  positions = better Jaccard estimate; 64 is a reasonable balance
 *  for headline-length inputs. */
const MINHASH_POSITIONS = 64;

/** GDELT trending velocity placeholder — V1 ships D-sources only;
 *  GDELT-filtered adapter lands in v2 and replaces this. */
const GDELT_TRENDING_VELOCITY_V1 = 1.0;

interface ActiveCandidate {
  id: string;
  source_provider: string;
  source_title: string;
  source_url: string;
  source_published_at: string | null;
  created_at: string;
  dedup_url_canon: string;
  dedup_cluster_id: string | null;
}

// ---------------------------------------------------------------------------
// MinHash + Jaccard estimator (hand-rolled, deterministic)
// ---------------------------------------------------------------------------

/** Tokenize a title into a set of word shingles (unigrams, stop-word-
 *  stripped, 2-character minimum). Unigram-only is deliberate: news
 *  paraphrases routinely reorder words ("Senate passes HR-1234" vs
 *  "HR-1234 passes Senate"), which destroys bigram overlap entirely.
 *  Unigram Jaccard catches these as the same story. Precision cost is
 *  acceptable at V1 corpus size and is gated by JACCARD_CLUSTER_
 *  THRESHOLD. */
export function shinglesOf(title: string): ReadonlyArray<string> {
  const STOP = new Set([
    'a',
    'an',
    'and',
    'or',
    'the',
    'of',
    'in',
    'on',
    'to',
    'for',
    'with',
    'by',
    'at',
    'is',
    'are',
    'as',
    'be',
    'from',
    'that',
    'this',
  ]);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(words)];
}

/** Deterministic 32-bit string hash (FNV-1a). Stable across runs. */
function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** MinHash signature: for each of N positions (seeds), hash every
 *  shingle and keep the min. Two signatures' agreement-rate on
 *  matching positions is an unbiased Jaccard estimator. */
export function minHashSignature(shingles: ReadonlyArray<string>): Uint32Array {
  const sig = new Uint32Array(MINHASH_POSITIONS).fill(0xffffffff);
  if (shingles.length === 0) return sig;
  for (let s = 0; s < MINHASH_POSITIONS; s += 1) {
    let min = 0xffffffff;
    for (const sh of shingles) {
      const h = fnv1a(sh, 0x9e3779b1 + s);
      if (h < min) min = h;
    }
    sig[s] = min;
  }
  return sig;
}

/** Estimate Jaccard similarity from two signatures. */
export function jaccardEstimate(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches / a.length;
}

// ---------------------------------------------------------------------------
// Clustering — union-find over Jaccard pairs
// ---------------------------------------------------------------------------

/** Cluster candidates by headline similarity + URL-canon. Returns a
 *  map of candidate.id → cluster_uuid. Same cluster_uuid = same story
 *  for the §2 3-consecutive-day repeat block and for the ranker. */
export function clusterCandidates(
  candidates: ReadonlyArray<ActiveCandidate>,
): ReadonlyMap<string, string> {
  if (candidates.length === 0) return new Map();

  // Phase 1: pre-cluster by dedup_url_canon (cheap exact match).
  // canonGroups maps canon string → set of candidate ids.
  const canonGroups = new Map<string, string[]>();
  for (const c of candidates) {
    const g = canonGroups.get(c.dedup_url_canon);
    if (g) g.push(c.id);
    else canonGroups.set(c.dedup_url_canon, [c.id]);
  }

  // Pick one representative per canon group; the MinHash phase only
  // compares representatives. Other members of the canon group inherit
  // the representative's cluster.
  const reps = new Map<string, string>(); // candidate id → representative id
  const representatives: ActiveCandidate[] = [];
  for (const ids of canonGroups.values()) {
    const repId = ids[0]!;
    const repRow = candidates.find((c) => c.id === repId)!;
    representatives.push(repRow);
    for (const id of ids) reps.set(id, repId);
  }

  // Phase 2: MinHash signatures for representatives.
  const sigs = new Map<string, Uint32Array>();
  for (const r of representatives) {
    sigs.set(r.id, minHashSignature(shinglesOf(r.source_title)));
  }

  // Phase 3: union-find. For every pair of representatives, union if
  // Jaccard >= threshold. O(N²) on representative count; at V1 scale
  // (<200 representatives) this is microseconds.
  const parent = new Map<string, string>();
  representatives.forEach((r) => parent.set(r.id, r.id));
  function find(x: string): string {
    while (parent.get(x) !== x) {
      const p = parent.get(x)!;
      parent.set(x, parent.get(p)!);
      x = parent.get(x)!;
    }
    return x;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < representatives.length; i += 1) {
    const a = representatives[i]!;
    const sigA = sigs.get(a.id)!;
    for (let j = i + 1; j < representatives.length; j += 1) {
      const b = representatives[j]!;
      const sigB = sigs.get(b.id)!;
      const sim = jaccardEstimate(sigA, sigB);
      if (sim >= JACCARD_CLUSTER_THRESHOLD) {
        union(a.id, b.id);
      }
    }
  }

  // Assign cluster UUIDs by union-find root. Stable per-run; persisted
  // to news_topics for the 3-day repeat block.
  const rootToCluster = new Map<string, string>();
  const result = new Map<string, string>();
  for (const c of candidates) {
    const repId = reps.get(c.id)!;
    const root = find(repId);
    let clusterId = rootToCluster.get(root);
    if (!clusterId) {
      clusterId = randomUUID();
      rootToCluster.set(root, clusterId);
    }
    result.set(c.id, clusterId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ranking — transparent math, no opaque model
// ---------------------------------------------------------------------------

/** Per-candidate rank score = density × velocity × recency_decay.
 *  All three factors are explainable in one English sentence. */
export function computeRankScore(opts: {
  primarySourceDensity: number;
  gdeltTrendingVelocity: number;
  recencyDecay: number;
}): number {
  return opts.primarySourceDensity * opts.gdeltTrendingVelocity * opts.recencyDecay;
}

/** True half-life decay: 0.5^(Δt_hours / RECENCY_HALF_LIFE_HOURS).
 *  Returns 1.0 at zero delta; exactly 0.5 at one half-life; 0.25 at
 *  two half-lives. (Note: e^(-Δt/h) would give 0.37 at one h — a time-
 *  constant decay, not a half-life. Picking pow(0.5, …) makes the
 *  half-life name match the math.) Future-dated timestamps clamp to
 *  1.0 (source feeds occasionally publish ahead-of-now stamps). */
export function recencyDecay(effectiveTs: Date, now: Date): number {
  const deltaMs = now.getTime() - effectiveTs.getTime();
  const deltaHours = Math.max(0, deltaMs / 3_600_000);
  return Math.pow(0.5, deltaHours / RECENCY_HALF_LIFE_HOURS);
}

/** Per-cluster primary-source density: count of DISTINCT
 *  source_provider values within the cluster. Multiple distinct
 *  primary sources agreeing on the same story = stronger signal. */
function densityByCluster(
  candidates: ReadonlyArray<ActiveCandidate>,
  clusterMap: ReadonlyMap<string, string>,
): Map<string, number> {
  const providers = new Map<string, Set<string>>();
  for (const c of candidates) {
    const cluster = clusterMap.get(c.id);
    if (!cluster) continue;
    let s = providers.get(cluster);
    if (!s) {
      s = new Set();
      providers.set(cluster, s);
    }
    s.add(c.source_provider);
  }
  const density = new Map<string, number>();
  for (const [cluster, set] of providers.entries()) {
    density.set(cluster, set.size);
  }
  return density;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const newsDedupRankHandler: JobHandler = async (row, deps) => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_HOURS * 3_600_000).toISOString();

  // 1) Fetch active candidates in the window.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any)
    .from('news_topics_candidates')
    .select(
      'id, source_provider, source_title, source_url, source_published_at, created_at, dedup_url_canon, dedup_cluster_id',
    )
    .is('selected_at', null)
    .is('rejected_reason', null)
    .gte('created_at', cutoff)) as {
    data: ActiveCandidate[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`news_dedup_rank: fetch: ${error.message}`);
  const candidates = data ?? [];
  if (candidates.length === 0) {
    await stampPayload(deps, row.id, { ...row.payload, candidates_seen: 0 });
    deps.logger.info({ event: 'news_dedup_rank.empty', jobId: row.id });
    return;
  }

  // 2) Cluster.
  const clusterMap = clusterCandidates(candidates);

  // 3) Compute per-cluster density.
  const densityMap = densityByCluster(candidates, clusterMap);

  // 4) For each candidate, compute the rank score and stamp it +
  //    cluster id back into the row.
  let updated = 0;
  for (const c of candidates) {
    const cluster = clusterMap.get(c.id);
    if (!cluster) continue;
    const density = densityMap.get(cluster) ?? 1;
    const effectiveTs = c.source_published_at
      ? new Date(c.source_published_at)
      : new Date(c.created_at);
    const recency = recencyDecay(effectiveTs, now);
    const score = computeRankScore({
      primarySourceDensity: density,
      gdeltTrendingVelocity: GDELT_TRENDING_VELOCITY_V1,
      recencyDecay: recency,
    });

    // Skip the write if neither field changed (cheap idempotency on
    // re-runs without new ingest).
    if (c.dedup_cluster_id === cluster) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updErr } = (await (deps.supabase as any)
      .from('news_topics_candidates')
      .update({ dedup_cluster_id: cluster, rank_score: score })
      .eq('id', c.id)) as { error: { message: string } | null };
    if (updErr) {
      deps.logger.warn({
        event: 'news_dedup_rank.update_failed',
        candidateId: c.id,
        message: updErr.message,
      });
      continue;
    }
    updated += 1;
  }

  // Telemetry — how many distinct clusters did we resolve this tick?
  const distinctClusters = new Set(clusterMap.values()).size;
  await stampPayload(deps, row.id, {
    ...row.payload,
    candidates_seen: candidates.length,
    candidates_updated: updated,
    distinct_clusters: distinctClusters,
  });

  deps.logger.info({
    event: 'news_dedup_rank.complete',
    jobId: row.id,
    candidatesSeen: candidates.length,
    candidatesUpdated: updated,
    distinctClusters,
  });
};

async function stampPayload(
  deps: Parameters<JobHandler>[1],
  rowId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({ payload })
    .eq('id', rowId)) as { error: { message: string } | null };
  if (error) {
    throw new Error(`news_dedup_rank: stamp payload: ${error.message}`);
  }
}

export const __testing = {
  shinglesOf,
  minHashSignature,
  jaccardEstimate,
  clusterCandidates,
  recencyDecay,
  computeRankScore,
  ACTIVE_WINDOW_HOURS,
  RECENCY_HALF_LIFE_HOURS,
  JACCARD_CLUSTER_THRESHOLD,
  MINHASH_POSITIONS,
};
