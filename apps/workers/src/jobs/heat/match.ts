// heat_signal_match — scheduler-spine worker that links trend_signals
// to GDELT event clusters. Runs every 15 min via pg_cron (migration
// 20261024000000, M2).
//
// Scope: this worker only READS gdelt_event_cluster / outlet / news_
// topics_candidates and WRITES trend_signals.global_event_id (+ match_
// quality) + trend_signals_unmatched. It does NOT change which Drop
// gets picked and runs behind HEAT_ENABLED=false — attaching signals
// to clusters is purely a prerequisite for the composer (which also
// stays shadow-only).
//
// Match ladder (highest confidence first):
//
//   1. URL match. google_trends items ship payload.news_items[].url
//      — compare each item's canonicalized URL against:
//         (a) gdelt_event_cluster.primary_url / best_news_url
//         (b) gdelt_event_cluster_outlet.url
//      First hit wins; cluster is unambiguous.
//
//   2. Token + time overlap. Tokenize the signal's primary text
//      (`title` / `topic` / `trend_name` / `displayName`) and each
//      cluster's accumulated candidate.source_title. Require >= 2
//      shared non-stopword tokens AND signal.created_at within
//      [cluster.first_seen_at - 2h, cluster.last_seen_at + 6h]. Ties
//      resolved by highest shared-token count, then lowest time
//      delta.
//
// Idempotent: the UPDATE guards on `global_event_id IS NULL`, so a
// re-tick after a matched row has already been linked no-ops. The
// unmatched sink INSERT is upsert-ON-CONFLICT-DO-NOTHING keyed on
// (source, source_id) via the unique index in M2.
//
// Give-up: a signal that is older than 1 hour (two tick cycles) and
// still unattached gets a single row into trend_signals_unmatched.
// Signal rows age out naturally at 72h via the planned retention
// sweep; the audit sink stays small.

import { scrubMessage } from '@diktat/shared/alerts';

import type { Database } from '@diktat/db';

import type { JobHandler, ScheduledJobRow } from '../scheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling-window the matcher scans. Matches the 72h signal retention. */
const SIGNAL_WINDOW_HOURS = 72;

/** Give-up threshold: a signal unattached this long is written to the
 *  unmatched sink. 1h = 4 tick cycles — if 4 ticks of GDELT cluster
 *  updates haven't produced a match, further ticks are unlikely to. */
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;

/** Per-tick signal batch cap. Protects the worker loop from a backlog
 *  spike. 500 is comfortably above a 15-min burst at steady state. */
const MAX_SIGNALS_PER_TICK = 500;

/** Token-overlap threshold for a token+time match. */
const TOKEN_MATCH_MIN_SHARED = 2;

/** Time-window around a cluster's seen range (ms). Signal time must
 *  fall inside [first_seen_at - PRE, last_seen_at + POST]. */
const CLUSTER_WINDOW_PRE_MS = 2 * 60 * 60 * 1000;
const CLUSTER_WINDOW_POST_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tokenization — exported for tests
// ---------------------------------------------------------------------------

/** Tiny English stopword set tuned for news headlines. Not exhaustive;
 *  the goal is to prevent "the", "a", "to", "of" from matching every
 *  signal to every cluster. Pure news-domain words (election, bill,
 *  president, …) are deliberately NOT in the stopword list — they
 *  carry topic signal. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'he',
  'her',
  'his',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'she',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'will',
  'with',
  'you',
  'your',
]);

/** Lowercase, strip punctuation, split on whitespace, drop stopwords
 *  and very short tokens. Returns a Set so overlap is O(min(|a|,|b|)). */
export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim();
  const out = new Set<string>();
  if (normalized.length === 0) return out;
  for (const t of normalized.split(/\s+/)) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Count shared tokens between two sets. */
export function countShared(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) if (large.has(t)) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// URL canonicalization — exported for tests
// ---------------------------------------------------------------------------

/** Lower-case the host, strip "www.", drop the query string + fragment,
 *  drop trailing slash on the path. Keeps http(s) scheme. Mirrors the
 *  intent of news-ingest's dedup_url_canon pipeline at a lighter
 *  level — enough to catch "AP piece served from apnews.com and
 *  copied into GDELT with a UTM tag" level dupes. */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.protocol}//${host}${path}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signal primary-text extraction
// ---------------------------------------------------------------------------

interface GoogleTrendsPayload {
  readonly title?: string;
  readonly news_items?: ReadonlyArray<{ readonly url?: string; readonly title?: string }>;
}

interface BlueskyPayload {
  readonly topic?: string;
  readonly displayName?: string;
}

interface XTrendsPayload {
  readonly trend_name?: string;
}

interface WikimediaPayload {
  readonly article?: string;
}

/** Pick the "primary text" the matcher tokenizes for a signal. */
export function signalPrimaryText(
  source: Database['public']['Enums']['trend_signal_source'],
  payload: Record<string, unknown>,
  fallbackSourceId: string,
): string {
  switch (source) {
    case 'google_trends': {
      const p = payload as GoogleTrendsPayload;
      // Fold news_item titles in alongside the trend title — they
      // typically carry entity names the matcher wants to see.
      const parts: string[] = [];
      if (typeof p.title === 'string') parts.push(p.title);
      for (const ni of p.news_items ?? []) {
        if (typeof ni.title === 'string') parts.push(ni.title);
      }
      return parts.length > 0 ? parts.join(' ') : fallbackSourceId;
    }
    case 'bluesky': {
      const p = payload as BlueskyPayload;
      const parts: string[] = [];
      if (typeof p.topic === 'string') parts.push(p.topic);
      if (typeof p.displayName === 'string') parts.push(p.displayName);
      return parts.length > 0 ? parts.join(' ') : fallbackSourceId;
    }
    case 'x_trends': {
      const p = payload as XTrendsPayload;
      return typeof p.trend_name === 'string' ? p.trend_name : fallbackSourceId;
    }
    case 'wikimedia_pageviews': {
      const p = payload as WikimediaPayload;
      // Replace underscores — Wikipedia article slugs are
      // "Winter_weather" shape.
      return typeof p.article === 'string' ? p.article.replace(/_/g, ' ') : fallbackSourceId;
    }
    case 'reddit':
    default:
      return fallbackSourceId;
  }
}

/** Pull every news_item URL out of a google_trends payload for the
 *  URL-match pass. Returns empty for non-google_trends sources. */
export function signalCandidateUrls(
  source: Database['public']['Enums']['trend_signal_source'],
  payload: Record<string, unknown>,
): string[] {
  if (source !== 'google_trends') return [];
  const p = payload as GoogleTrendsPayload;
  const out: string[] = [];
  for (const ni of p.news_items ?? []) {
    if (typeof ni.url === 'string') out.push(ni.url);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Match engine (pure)
// ---------------------------------------------------------------------------

export interface MatchQuality {
  readonly method: 'url' | 'token_time';
  readonly score: number;
  readonly shared_tokens?: number;
  readonly matched_url?: string;
  readonly cluster_window_delta_ms?: number;
}

export interface MatchResult {
  readonly global_event_id: string;
  readonly match_quality: MatchQuality;
}

export interface ClusterIndexRow {
  readonly global_event_id: string;
  readonly first_seen_at_ms: number;
  readonly last_seen_at_ms: number;
  /** Pre-tokenized aggregate of every candidate.source_title and
   *  cluster-URL host-based entity hints that reach this cluster. */
  readonly tokens: Set<string>;
}

/** Build the url→global_event_id lookup from the three URL sources
 *  the matcher is willing to trust (primary_url, best_news_url, and
 *  every outlet URL in the cluster). */
export function buildUrlIndex(
  entries: ReadonlyArray<{ url: string; global_event_id: string }>,
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const e of entries) {
    const canon = canonicalizeUrl(e.url);
    if (!canon) continue;
    // First-seen wins; a URL hitting two clusters is pathological
    // (would mean GDELT emitted the same mention under two event
    // IDs). The URL-match path is deliberately not the arbiter in
    // that case — leave the second mapping alone.
    if (!idx.has(canon)) idx.set(canon, e.global_event_id);
  }
  return idx;
}

/** Try to match one signal against the loaded cluster set. Pure. */
export function matchSignal(
  signal: {
    readonly source: Database['public']['Enums']['trend_signal_source'];
    readonly source_id: string;
    readonly payload: Record<string, unknown>;
    readonly created_at_ms: number;
  },
  clusters: ReadonlyArray<ClusterIndexRow>,
  urlIndex: ReadonlyMap<string, string>,
): MatchResult | null {
  // Pass 1 — URL match.
  for (const raw of signalCandidateUrls(signal.source, signal.payload)) {
    const canon = canonicalizeUrl(raw);
    if (!canon) continue;
    const gid = urlIndex.get(canon);
    if (gid) {
      return {
        global_event_id: gid,
        match_quality: { method: 'url', score: 1.0, matched_url: canon },
      };
    }
  }
  // Pass 2 — token + time overlap.
  const tokens = tokenize(signalPrimaryText(signal.source, signal.payload, signal.source_id));
  if (tokens.size === 0) return null;
  let best: {
    gid: string;
    shared: number;
    delta: number;
  } | null = null;
  for (const c of clusters) {
    if (signal.created_at_ms < c.first_seen_at_ms - CLUSTER_WINDOW_PRE_MS) continue;
    if (signal.created_at_ms > c.last_seen_at_ms + CLUSTER_WINDOW_POST_MS) continue;
    const shared = countShared(tokens, c.tokens);
    if (shared < TOKEN_MATCH_MIN_SHARED) continue;
    // Delta is distance to the nearest point in [first, last].
    const delta =
      signal.created_at_ms < c.first_seen_at_ms
        ? c.first_seen_at_ms - signal.created_at_ms
        : signal.created_at_ms > c.last_seen_at_ms
          ? signal.created_at_ms - c.last_seen_at_ms
          : 0;
    if (best === null || shared > best.shared || (shared === best.shared && delta < best.delta)) {
      best = { gid: c.global_event_id, shared, delta };
    }
  }
  if (best === null) return null;
  // Score shape: shared/10 clipped to 0.95 so URL-match (1.0) always
  // outranks a token match in observability dashboards.
  return {
    global_event_id: best.gid,
    match_quality: {
      method: 'token_time',
      score: Math.min(0.95, best.shared / 10),
      shared_tokens: best.shared,
      cluster_window_delta_ms: best.delta,
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface StampPayload {
  readonly emitted_at?: string;
  readonly outcome: 'ok' | 'degraded_db';
  readonly scanned?: number;
  readonly matched?: number;
  readonly gave_up?: number;
  readonly reason?: string;
}

function emittedAtFromRow(row: ScheduledJobRow): string | undefined {
  const v = row.payload.emitted_at;
  return typeof v === 'string' ? v : undefined;
}

/** Build the heat_signal_match handler. Pure factory for `now` injection
 *  in tests. */
export function buildHeatSignalMatchHandler(opts?: { readonly now?: () => Date }): JobHandler {
  const now = opts?.now ?? (() => new Date());
  return async function heatSignalMatchHandler(row: ScheduledJobRow, deps): Promise<void> {
    const startedAt = now();
    const windowStartIso = new Date(
      startedAt.getTime() - SIGNAL_WINDOW_HOURS * 3600 * 1000,
    ).toISOString();

    // 1. Load unattached signals.
    const { data: signals, error: sigErr } = await deps.supabase
      .from('trend_signals')
      .select('id, source, source_id, payload, created_at')
      .is('global_event_id', null)
      .gt('created_at', windowStartIso)
      .order('created_at', { ascending: true })
      .limit(MAX_SIGNALS_PER_TICK);
    if (sigErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        reason: scrubMessage(sigErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'heat_signal_match.signals_load_failed',
        message: scrubMessage(sigErr.message),
      });
      return;
    }
    const sigs = signals ?? [];
    if (sigs.length === 0) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'ok',
        scanned: 0,
        matched: 0,
        gave_up: 0,
      });
      deps.logger.info({
        event: 'heat_signal_match.complete',
        jobId: row.id,
        scanned: 0,
        matched: 0,
        gave_up: 0,
      });
      return;
    }

    // 2. Load active clusters + their outlet URLs + their candidate
    //    source_titles.
    const { data: clusters, error: clErr } = await deps.supabase
      .from('gdelt_event_cluster')
      .select('global_event_id, first_seen_at, last_seen_at, primary_url, best_news_url')
      .gt('last_seen_at', windowStartIso)
      .is('drop_published_at', null);
    if (clErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        reason: scrubMessage(clErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'heat_signal_match.clusters_load_failed',
        message: scrubMessage(clErr.message),
      });
      return;
    }
    const cls = clusters ?? [];
    const clusterIds = cls.map((c) => c.global_event_id);
    const { data: outlets, error: outErr } =
      clusterIds.length === 0
        ? { data: [], error: null as { message: string } | null }
        : await deps.supabase
            .from('gdelt_event_cluster_outlet')
            .select('global_event_id, url')
            .in('global_event_id', clusterIds);
    if (outErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        reason: scrubMessage(outErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'heat_signal_match.outlets_load_failed',
        message: scrubMessage(outErr.message),
      });
      return;
    }
    const { data: candidates, error: candErr } =
      clusterIds.length === 0
        ? { data: [], error: null as { message: string } | null }
        : await deps.supabase
            .from('news_topics_candidates')
            .select('global_event_id, source_title')
            .in('global_event_id', clusterIds);
    if (candErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        reason: scrubMessage(candErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'heat_signal_match.candidates_load_failed',
        message: scrubMessage(candErr.message),
      });
      return;
    }

    // 3. Build the url-index and the per-cluster token sets.
    const urlEntries: { url: string; global_event_id: string }[] = [];
    for (const c of cls) {
      if (c.primary_url)
        urlEntries.push({ url: c.primary_url, global_event_id: c.global_event_id });
      if (c.best_news_url)
        urlEntries.push({ url: c.best_news_url, global_event_id: c.global_event_id });
    }
    for (const o of outlets ?? []) {
      if (o.global_event_id && o.url)
        urlEntries.push({ url: o.url, global_event_id: o.global_event_id });
    }
    const urlIndex = buildUrlIndex(urlEntries);

    const clusterTokens = new Map<string, Set<string>>();
    for (const cand of candidates ?? []) {
      if (!cand.global_event_id || !cand.source_title) continue;
      const existing = clusterTokens.get(cand.global_event_id) ?? new Set<string>();
      for (const t of tokenize(cand.source_title)) existing.add(t);
      clusterTokens.set(cand.global_event_id, existing);
    }
    const clusterIndex: ClusterIndexRow[] = cls.map((c) => ({
      global_event_id: c.global_event_id,
      first_seen_at_ms: Date.parse(c.first_seen_at),
      last_seen_at_ms: Date.parse(c.last_seen_at),
      tokens: clusterTokens.get(c.global_event_id) ?? new Set<string>(),
    }));

    // 4. Walk the unattached signals.
    let matched = 0;
    let gaveUp = 0;
    const nowMs = startedAt.getTime();
    for (const sig of sigs) {
      const createdMs = Date.parse(sig.created_at);
      const result = matchSignal(
        {
          source: sig.source,
          source_id: sig.source_id,
          payload: (sig.payload ?? {}) as Record<string, unknown>,
          created_at_ms: createdMs,
        },
        clusterIndex,
        urlIndex,
      );
      if (result) {
        const { error: updErr } = await deps.supabase
          .from('trend_signals')
          .update({
            global_event_id: result.global_event_id,
            match_quality:
              result.match_quality as unknown as Database['public']['Tables']['trend_signals']['Update']['match_quality'],
          })
          .eq('id', sig.id)
          .is('global_event_id', null);
        if (updErr) {
          deps.logger.warn({
            event: 'heat_signal_match.update_failed',
            signal_id: sig.id,
            message: scrubMessage(updErr.message),
          });
          continue;
        }
        matched += 1;
      } else if (nowMs - createdMs >= GIVE_UP_AFTER_MS) {
        const { error: insErr } = await deps.supabase.from('trend_signals_unmatched').upsert(
          {
            source: sig.source,
            source_id: sig.source_id,
            payload: sig.payload ?? {},
            reason: 'no_match_after_1h',
          } as Database['public']['Tables']['trend_signals_unmatched']['Insert'],
          { onConflict: 'source,source_id', ignoreDuplicates: true },
        );
        if (insErr) {
          deps.logger.warn({
            event: 'heat_signal_match.unmatched_insert_failed',
            signal_id: sig.id,
            message: scrubMessage(insErr.message),
          });
          continue;
        }
        gaveUp += 1;
      }
    }

    await stampPayload(deps, row.id, {
      emitted_at: emittedAtFromRow(row),
      outcome: 'ok',
      scanned: sigs.length,
      matched,
      gave_up: gaveUp,
    });
    deps.logger.info({
      event: 'heat_signal_match.complete',
      jobId: row.id,
      scanned: sigs.length,
      matched,
      gave_up: gaveUp,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

async function stampPayload(
  deps: Parameters<JobHandler>[1],
  rowId: string,
  payload: StampPayload,
): Promise<void> {
  const { error } = await deps.supabase
    .from('scheduled_jobs')
    .update({
      payload:
        payload as unknown as Database['public']['Tables']['scheduled_jobs']['Update']['payload'],
    })
    .eq('id', rowId);
  if (error) {
    deps.logger.debug({
      event: 'heat_signal_match.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

/** Default handler instance — registered in the scheduler. */
export const heatSignalMatchHandler: JobHandler = buildHeatSignalMatchHandler();
