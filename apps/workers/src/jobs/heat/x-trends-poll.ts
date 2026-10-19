// x_trends_poll — polls the X v2 Trends-by-WOEID endpoint hourly
// via the scheduler spine. Verified against docs.x.com Oct 2026:
// pay-per-usage pricing, $0.010/request, 75 req/15min per app rate
// limit, 24h-resource dedup on identical calls.
//
//   GET https://api.x.com/2/trends/by/woeid/23424977    (US)
//
// Hourly cadence = 24 req/day × $0.010 = $0.24/day = ~$7.20/mo at
// the ceiling. A hard daily call cap (MAX_CALLS_PER_UTC_DAY) in
// code defends against accidental tight loops regardless of pg_cron
// state. No live calls tonight — operator rule for the overnight
// batch — the handler is gated by X_TRENDS_ENABLED=false by
// default, and the bearer token is read from env only (never
// touched in this PR).
//
// Display/redistribution guard: per X Developer Agreement + the
// per-service X API ToS, trend text and tweet volumes delivered to
// an application developer may NOT be redistributed to end users
// in raw form. The trend_signals / trend_signals_unmatched tables
// are RLS-enabled with NO authenticated/anon policies and NO
// GRANTs (migration 20261023000000); service_role is the sole
// writer and reader. A hypothetical future UI render of X trend
// text or counts must land in a separate table/view with explicit
// operator decision, not read through these tables.
//
// Response schema (per docs.x.com): the endpoint shape may or may
// not include `tweet_volume` in v2; parser handles either case.
// Operator plan v3 open-decision 1: this PR writes a presence row
// when volume absent and a volume row when present.

import { scrubMessage } from '@diktat/shared/alerts';

import type { Database } from '@diktat/db';

import { loadEnv, type Env } from '../../env.js';
import type { JobHandler, ScheduledJobRow } from '../scheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** US WOEID per docs.x.com Trends-by-WOEID reference. */
export const X_TRENDS_US_WOEID = 23424977;

export const X_TRENDS_URL = `https://api.x.com/2/trends/by/woeid/${X_TRENDS_US_WOEID}`;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS_PER_TICK = 50;
const MAX_TREND_NAME_CHARS = 128;

/** Hard daily call cap. 24 is the hourly target; 48 is a 2x safety
 *  margin that still ships well under $0.48/day. If this cap trips,
 *  something is wrong (clock drift, duplicate cron) — fail closed. */
const MAX_CALLS_PER_UTC_DAY = 48;

type TrendSignalInsert = Database['public']['Tables']['trend_signals']['Insert'];
type ScheduledJobsUpdate = Database['public']['Tables']['scheduled_jobs']['Update'];

// ---------------------------------------------------------------------------
// UTC bucket (hourly; mirrors google/bluesky)
// ---------------------------------------------------------------------------

export function toUtcHourBucket(d: Date): string {
  return d.toISOString().slice(0, 13);
}

export function toUtcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function normalizeTrendForSourceId(trend: string): string {
  return trend.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface XTrend {
  readonly trend_name: string;
  readonly tweet_volume: number | null;
}

/** Normalize to { trend_name, tweet_volume? }. docs.x.com example
 *  shows {trend_name} only; some tiers return {trend_name,
 *  tweet_volume}. Tolerate both. */
export function parseXTrendsBody(body: string): XTrend[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { data?: unknown; trends?: unknown };
  // docs.x.com v2 wraps in `{data: [...]}`; be flexible if the
  // schema drifts under us.
  const list = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.trends) ? obj.trends : null;
  if (!list) return [];
  const out: XTrend[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.trend_name === 'string' ? r.trend_name.trim() : '';
    if (name.length === 0) continue;
    const vol =
      typeof r.tweet_volume === 'number' && Number.isFinite(r.tweet_volume) && r.tweet_volume >= 0
        ? Math.floor(r.tweet_volume)
        : null;
    out.push({ trend_name: name.slice(0, MAX_TREND_NAME_CHARS), tweet_volume: vol });
    if (out.length >= MAX_ITEMS_PER_TICK) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchXTrends(fetchImpl: typeof globalThis.fetch, bearer: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(X_TRENDS_URL, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'user-agent': 'diktat.app/heat-collector (contact ops@diktat.app)',
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`x_trends_poll: fetch returned ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('x_trends_poll: response has no readable body');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error(`x_trends_poll: body exceeded ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder('utf-8').decode(combined);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Insert + daily-call cap
// ---------------------------------------------------------------------------

interface InsertRow {
  readonly source: 'x_trends';
  readonly source_id: string;
  readonly payload: Record<string, unknown>;
}

async function insertSignals(
  deps: Parameters<JobHandler>[1],
  rows: ReadonlyArray<InsertRow>,
): Promise<{ attempted: number; failed: number }> {
  if (rows.length === 0) return { attempted: 0, failed: 0 };
  const { error } = await deps.supabase
    .from('trend_signals')
    .upsert(rows as unknown as TrendSignalInsert[], {
      onConflict: 'source,source_id',
      ignoreDuplicates: true,
    });
  if (error) {
    deps.logger.warn({
      event: 'x_trends_poll.insert_failed',
      message: scrubMessage(error.message),
      attempted: rows.length,
    });
    return { attempted: rows.length, failed: rows.length };
  }
  return { attempted: rows.length, failed: 0 };
}

interface StampPayload {
  readonly emitted_at?: string;
  readonly outcome:
    | 'ok'
    | 'disabled'
    | 'no_bearer'
    | 'daily_cap_hit'
    | 'degraded_count'
    | 'degraded_fetch'
    | 'degraded_parse';
  readonly reason?: string;
  readonly fetched?: number;
  readonly inserted_attempted?: number;
  readonly inserted_failed?: number;
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
      event: 'x_trends_poll.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

/** Count observed x_trends_poll `scheduled_jobs` done-rows for today
 *  (UTC). The cap compares against this count — a conservative read:
 *  rows with outcome='ok' that already landed. 'disabled' rows don't
 *  consume calls.
 *
 *  Returns `null` on DB error so the caller can fail CLOSED (skip the
 *  live call for this tick). The X v2 Trends endpoint is pay-per-call
 *  — an unknown-count tick that proceeds would risk running the daily
 *  cap over on repeated transient DB failures. The cost of a skipped
 *  tick is one missed 30-minute bucket; the cost of running over is
 *  real USD. */
async function countCallsToday(
  deps: Parameters<JobHandler>[1],
  dayUtc: string,
): Promise<number | null> {
  // Date boundaries at midnight UTC.
  const start = `${dayUtc}T00:00:00Z`;
  const end = `${dayUtc}T23:59:59Z`;
  // Count by scanning payload->>outcome='ok' from matching rows via a
  // builder-expressible filter: we fetch id + payload for the day
  // and tally in TS. The row volume is bounded (max 48/day), so this
  // is cheap and index-friendly on created_at.
  const { data, error } = await deps.supabase
    .from('scheduled_jobs')
    .select('id, payload')
    .eq('job_type', 'x_trends_poll')
    .gte('created_at', start)
    .lte('created_at', end);
  if (error) {
    deps.logger.warn({
      event: 'x_trends_poll.count_failed',
      message: scrubMessage(error.message),
    });
    return null;
  }
  let n = 0;
  for (const r of data ?? []) {
    const o = (r.payload as { outcome?: unknown } | null)?.outcome;
    if (o === 'ok') n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildXTrendsPollHandler(opts?: {
  readonly now?: () => Date;
  readonly envProvider?: () => Env;
}): JobHandler {
  const now = opts?.now ?? (() => new Date());
  const envProvider = opts?.envProvider ?? loadEnv;
  return async function xTrendsPollHandler(row: ScheduledJobRow, deps): Promise<void> {
    const env = envProvider();
    const startedAt = now();
    const bucket = toUtcHourBucket(startedAt);
    const day = toUtcDay(startedAt);

    if (!env.X_TRENDS_ENABLED) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'disabled',
      });
      deps.logger.info({ event: 'x_trends_poll.disabled', jobId: row.id });
      return;
    }
    if (!env.X_BEARER_TOKEN || env.X_BEARER_TOKEN.length === 0) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'no_bearer',
      });
      deps.logger.warn({ event: 'x_trends_poll.no_bearer', jobId: row.id });
      return;
    }

    const callsToday = await countCallsToday(deps, day);
    if (callsToday === null) {
      // Fail CLOSED on count DB error: skip the paid X call for this
      // tick rather than risk running the daily cap over on repeated
      // transient failures. Cost of skip = one missed 30-minute bucket;
      // cost of a wrong-count overshoot = real USD.
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_count',
      });
      deps.logger.warn({ event: 'x_trends_poll.degraded_count', jobId: row.id });
      return;
    }
    if (callsToday >= MAX_CALLS_PER_UTC_DAY) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'daily_cap_hit',
        reason: `calls_today=${callsToday} >= cap=${MAX_CALLS_PER_UTC_DAY}`,
      });
      deps.logger.warn({
        event: 'x_trends_poll.daily_cap_hit',
        jobId: row.id,
        calls_today: callsToday,
        cap: MAX_CALLS_PER_UTC_DAY,
      });
      return;
    }

    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('x_trends_poll: no fetch implementation available');
    }

    let body: string;
    try {
      body = await fetchXTrends(fetchImpl, env.X_BEARER_TOKEN);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({ event: 'x_trends_poll.fetch_failed', message });
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_fetch',
        reason: message.slice(0, 256),
      });
      return;
    }

    let items: XTrend[];
    try {
      items = parseXTrendsBody(body);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({ event: 'x_trends_poll.parse_failed', message });
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_parse',
        reason: message.slice(0, 256),
      });
      return;
    }

    const rows: InsertRow[] = items.map((t) => ({
      source: 'x_trends',
      source_id: `${normalizeTrendForSourceId(t.trend_name)}|${bucket}`,
      payload: {
        trend_name: t.trend_name,
        tweet_volume: t.tweet_volume,
        collected_at: startedAt.toISOString(),
        bucket_utc_hour: bucket,
      },
    }));

    const insertResult = await insertSignals(deps, rows);
    await stampPayload(deps, row.id, {
      emitted_at: emittedAtFromRow(row),
      outcome: 'ok',
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
    });
    deps.logger.info({
      event: 'x_trends_poll.complete',
      jobId: row.id,
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

export const xTrendsPollHandler: JobHandler = buildXTrendsPollHandler();
