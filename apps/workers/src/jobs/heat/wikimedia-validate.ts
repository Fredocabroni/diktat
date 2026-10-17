// wikimedia_pageviews_validate — daily poll of the Wikimedia
// Pageviews REST API (en.wikipedia, all-access). Writes top-N
// articles for yesterday (UTC) into public.trend_signals.
//
// Verified endpoint live on 2026-10-16:
//
//   GET https://wikimedia.org/api/rest_v1/metrics/pageviews/top/
//       en.wikipedia/all-access/YYYY/MM/DD
//
// Public, no auth. Returns ~1000 ranked articles with `article`,
// `views`, `rank`. Latency ~24h — the daily cron fires at 10:00
// UTC against yesterday's date (safe margin).
//
// VALIDATION ONLY — NOT a primary heat source. These rows exist
// so the nightly operator-review digest (follow-up PR) can
// cross-check the day's Drop picks against yesterday's Wikipedia
// pageviews top-200. If a Drop pick's primary entity does not
// appear in that list, the digest flags it for review. The
// composer never reads from this source.
//
// Wikimedia Terms of Use require a descriptive User-Agent that
// identifies the application and provides contact — see
// https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy.
// All responses here are public CC BY-SA data; we don't attribute
// in rendered output because the rows never surface to users.

import { scrubMessage } from '@diktat/shared/alerts';

import type { Database } from '@diktat/db';

import { loadEnv, type Env } from '../../env.js';
import type { JobHandler, ScheduledJobRow } from '../scheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WIKIMEDIA_PAGEVIEWS_BASE =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access';

/** Wikimedia asks for a descriptive UA. */
const USER_AGENT = 'DiktatHeatCollector/0.1 (https://diktat.app; ops@diktat.app)';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // response is ~500 KiB; 4 MiB defensive.
/** Top-N articles persisted per day. We don't need all 1000. */
const TOP_N = 200;
const MAX_ARTICLE_CHARS = 256;

type TrendSignalInsert = Database['public']['Tables']['trend_signals']['Insert'];
type ScheduledJobsUpdate = Database['public']['Tables']['scheduled_jobs']['Update'];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function yesterdayUtcParts(now: Date): {
  year: string;
  month: string;
  day: string;
  iso: string;
} {
  const t = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const year = String(t.getUTCFullYear()).padStart(4, '0');
  const month = String(t.getUTCMonth() + 1).padStart(2, '0');
  const day = String(t.getUTCDate()).padStart(2, '0');
  return { year, month, day, iso: `${year}-${month}-${day}` };
}

export function wikimediaUrl(year: string, month: string, day: string): string {
  return `${WIKIMEDIA_PAGEVIEWS_BASE}/${year}/${month}/${day}`;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface WikimediaArticle {
  readonly article: string;
  readonly views: number;
  readonly rank: number;
}

export function parseWikimediaBody(body: string): WikimediaArticle[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { items?: unknown };
  if (!Array.isArray(obj.items) || obj.items.length === 0) return [];
  // Wikimedia returns one `items` entry wrapping the ranked articles array.
  const first = obj.items[0] as { articles?: unknown } | undefined;
  if (!first || !Array.isArray(first.articles)) return [];
  const out: WikimediaArticle[] = [];
  for (const raw of first.articles) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.article !== 'string' || r.article.length === 0) continue;
    if (typeof r.views !== 'number' || !Number.isFinite(r.views) || r.views < 0) continue;
    if (typeof r.rank !== 'number' || !Number.isFinite(r.rank) || r.rank < 1) continue;
    // Skip meta pages — Main_Page, Special:*, Portal:* — they're not
    // news entities and would pollute the validation set.
    if (
      r.article === 'Main_Page' ||
      r.article.startsWith('Special:') ||
      r.article.startsWith('Portal:') ||
      r.article.startsWith('Wikipedia:') ||
      r.article === '-'
    ) {
      continue;
    }
    out.push({
      article: r.article.slice(0, MAX_ARTICLE_CHARS),
      views: Math.floor(r.views),
      rank: Math.floor(r.rank),
    });
    if (out.length >= TOP_N) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchWikimedia(fetchImpl: typeof globalThis.fetch, url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`wikimedia_pageviews_validate: fetch returned ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('wikimedia_pageviews_validate: response has no readable body');
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
        throw new Error(`wikimedia_pageviews_validate: body exceeded ${MAX_BODY_BYTES} bytes`);
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
// Insert + stamp
// ---------------------------------------------------------------------------

interface InsertRow {
  readonly source: 'wikimedia_pageviews';
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
      event: 'wikimedia_pageviews_validate.insert_failed',
      message: scrubMessage(error.message),
      attempted: rows.length,
    });
    return { attempted: rows.length, failed: rows.length };
  }
  return { attempted: rows.length, failed: 0 };
}

interface StampPayload {
  readonly emitted_at?: string;
  readonly outcome: 'ok' | 'disabled' | 'degraded_fetch' | 'degraded_parse';
  readonly date_fetched?: string;
  readonly fetched?: number;
  readonly inserted_attempted?: number;
  readonly inserted_failed?: number;
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
      event: 'wikimedia_pageviews_validate.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildWikimediaValidateHandler(opts?: {
  readonly now?: () => Date;
  readonly envProvider?: () => Env;
}): JobHandler {
  const now = opts?.now ?? (() => new Date());
  const envProvider = opts?.envProvider ?? loadEnv;
  return async function wikimediaValidateHandler(row: ScheduledJobRow, deps): Promise<void> {
    const env = envProvider();
    const startedAt = now();
    const { year, month, day, iso } = yesterdayUtcParts(startedAt);

    if (!env.WIKIMEDIA_ENABLED) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'disabled',
        date_fetched: iso,
      });
      deps.logger.info({
        event: 'wikimedia_pageviews_validate.disabled',
        jobId: row.id,
        date: iso,
      });
      return;
    }

    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('wikimedia_pageviews_validate: no fetch implementation available');
    }

    const url = wikimediaUrl(year, month, day);
    let body: string;
    try {
      body = await fetchWikimedia(fetchImpl, url);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({ event: 'wikimedia_pageviews_validate.fetch_failed', message });
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_fetch',
        date_fetched: iso,
        reason: message.slice(0, 256),
      });
      return;
    }

    let items: WikimediaArticle[];
    try {
      items = parseWikimediaBody(body);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({ event: 'wikimedia_pageviews_validate.parse_failed', message });
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_parse',
        date_fetched: iso,
        reason: message.slice(0, 256),
      });
      return;
    }

    const rows: InsertRow[] = items.map((a) => ({
      source: 'wikimedia_pageviews',
      source_id: `en.wikipedia:${a.article}:${iso}`,
      payload: {
        project: 'en.wikipedia',
        article: a.article,
        views: a.views,
        rank: a.rank,
        date: iso,
        collected_at: startedAt.toISOString(),
      },
    }));

    const insertResult = await insertSignals(deps, rows);
    await stampPayload(deps, row.id, {
      emitted_at: emittedAtFromRow(row),
      outcome: 'ok',
      date_fetched: iso,
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
    });
    deps.logger.info({
      event: 'wikimedia_pageviews_validate.complete',
      jobId: row.id,
      date: iso,
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

export const wikimediaValidateHandler: JobHandler = buildWikimediaValidateHandler();
