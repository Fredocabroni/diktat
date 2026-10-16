// google_trends_poll — polls https://trends.google.com/trending/rss?geo=US
// every 15 min via the scheduler spine and writes rows into
// public.trend_signals (migration 20261023000000, M1).
//
// Why this exists: the Oct-15 Peshawar-shape Drop proved GDELT's
// distinct-outlet count measures press coverage, not audience heat.
// Google Trends' RSS is a free, no-auth, quantified volume signal
// (ht:approx_traffic) AND it comes with embedded news_item URLs that
// the matcher (follow-up PR) uses as deterministic cluster-match keys.
//
// Verified live against trends.google.com/trending/rss?geo=US on
// 2026-10-16 — the feed shape is stable:
//
//   <item>
//     <title>…</title>
//     <ht:approx_traffic>200+ ... 200000+</ht:approx_traffic>
//     <pubDate>…</pubDate>
//     <ht:picture>…</ht:picture>
//     <ht:picture_source>…</ht:picture_source>
//     <ht:news_item>
//       <ht:news_item_title>…</ht:news_item_title>
//       <ht:news_item_url>…</ht:news_item_url>
//       <ht:news_item_source>…</ht:news_item_source>
//       <ht:news_item_picture>…</ht:news_item_picture>
//     </ht:news_item>
//     … (multiple news_item blocks per trend)
//   </item>
//
// Degrade contract: ANY failure (fetch non-2xx, parse throw, timeout,
// Supabase insert error) is caught and logged with the row stamped
// payload={degraded:true,reason}. The scheduler sees a 'done' row and
// the next tick retries. No source can crash the Drop.
//
// Terms: Google Trends RSS is a public, no-auth, no-documented-rate-
// limit feed. We poll every 15 min = 96 req/day. If Google ever
// rate-limits us or deprecates the feed, degrade kicks in and the
// composer treats the gap as zero signal from this source.

import Parser from 'rss-parser';

import { scrubMessage } from '@diktat/shared/alerts';

import type { JobHandler, ScheduledJobRow } from '../scheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Official URL. Public, no auth. */
export const GOOGLE_TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=US';

/** Fetch timeout. Google serves this feed in <500ms steady-state;
 *  10s is enough slack for a transient slow response without turning
 *  into a tick blocker. */
const FETCH_TIMEOUT_MS = 10_000;

/** Body size cap. The feed is ~15-25 KiB. 2 MiB is a defensive ceiling
 *  that would survive a 10x expansion before refusing. */
const MAX_FEED_BYTES = 2 * 1024 * 1024;

/** Cap on how many trend items we persist per tick. The feed typically
 *  returns 10-20 items; 50 is defensive against a sudden shape change. */
const MAX_ITEMS_PER_TICK = 50;

/** Caps for stored strings. Protect index pages and payload size
 *  against hostile / mis-encoded feed values. */
const MAX_TITLE_CHARS = 256;
const MAX_URL_CHARS = 2048;
const MAX_SOURCE_CHARS = 128;

// ---------------------------------------------------------------------------
// Public types (exported so tests can type-check fixtures)
// ---------------------------------------------------------------------------

export interface GoogleTrendsNewsItem {
  readonly title: string;
  readonly url: string;
  readonly source: string;
}

export interface GoogleTrendsItem {
  readonly title: string;
  readonly approxTraffic: number | null;
  readonly pubDate: string | null;
  readonly newsItems: ReadonlyArray<GoogleTrendsNewsItem>;
}

// ---------------------------------------------------------------------------
// Approx-traffic parsing
// ---------------------------------------------------------------------------

/** Format a Date as a UTC-hour bucket `YYYY-MM-DDTHH`. Used as the
 *  time-bucket half of source_id so the same trend observed in two
 *  different hours produces two rows (preserves the time series the
 *  heat composer needs for the 12h decay term). Within one hour, the
 *  four 15-min ticks collapse into a single row via upsert's
 *  ignoreDuplicates on `(source, source_id)`. */
export function toUtcHourBucket(d: Date): string {
  return d.toISOString().slice(0, 13);
}

/** Normalize a trend title for use in `source_id`: lowercase + collapse
 *  whitespace. Keeps cosmetic variants ("ABC Co.", "abc co.") in the
 *  same hourly bucket. The display title (unnormalized) is preserved
 *  in payload.title. */
export function normalizeSourceIdTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parse Google Trends' approx_traffic strings into integers.
 *  Examples observed on 2026-10-16: "200+", "2000+", "20000+",
 *  "200000+", occasionally plain "1000". Values are bucketed powers-
 *  of-ten by Google. Returns null on parse failure (feed shape drift). */
export function parseApproxTraffic(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Strip the trailing '+' (and any surrounding whitespace Google
  // sometimes serves around it).
  const digits = trimmed.replace(/\+\s*$/, '').trim();
  // Strip thousands separators if any future feed shape adds them.
  const normalized = digits.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number.parseInt(normalized, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Feed fetch + parse
// ---------------------------------------------------------------------------

/** Fetch the RSS feed with a bounded timeout and a byte cap. Returns
 *  the decoded XML string. Throws on non-2xx, timeout, or oversize. */
async function fetchFeed(fetchImpl: typeof globalThis.fetch, url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        // Google requires a non-empty UA on these feeds; a bare fetch
        // without UA sometimes 403s. Identify the app plainly.
        'user-agent': 'diktat.app/heat-collector (contact ops@diktat.app)',
        accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1',
      },
    });
    if (!response.ok) {
      throw new Error(`google_trends_poll: fetch returned ${response.status}`);
    }
    // Read as bytes with a cap, then decode. Same pattern as the GDELT
    // adapter (news-ingest.ts) — defends against hostile oversized
    // payloads blowing out memory.
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('google_trends_poll: response has no readable body');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error(`google_trends_poll: feed exceeded ${MAX_FEED_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(combined);
  } finally {
    clearTimeout(timeout);
  }
}

/** rss-parser wraps every namespaced child element in a single-element
 *  array because xml2js can't tell whether an element will repeat. The
 *  Google Trends feed emits each ht:news_item_* as a scalar inside its
 *  parent `<ht:news_item>`, so we read `arr[0]` (or ''). */
function firstString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return '';
}

/** Parse Google Trends RSS into a normalized item list. Only exported
 *  for tests. */
export async function parseGoogleTrendsRss(xml: string): Promise<GoogleTrendsItem[]> {
  // rss-parser consumes namespaced custom fields via customFields.item.
  // Each namespaced field becomes an item property under the aliased
  // name. `keepArray: true` on ht:news_item preserves the multiple-
  // news-item structure (default behaviour on duplicated child elements
  // is to keep only the last).
  interface ParsedNewsItem {
    readonly 'ht:news_item_title'?: unknown;
    readonly 'ht:news_item_url'?: unknown;
    readonly 'ht:news_item_source'?: unknown;
  }
  interface ParsedItem {
    readonly title?: string;
    readonly approxTraffic?: unknown;
    readonly pubDate?: string;
    readonly newsItems?: ReadonlyArray<ParsedNewsItem>;
  }
  const parser = new Parser<Record<string, unknown>, ParsedItem>({
    customFields: {
      item: [
        ['ht:approx_traffic', 'approxTraffic'],
        ['ht:news_item', 'newsItems', { keepArray: true }],
      ],
    },
  });
  const feed = await parser.parseString(xml);
  const items = feed.items ?? [];
  const out: GoogleTrendsItem[] = [];
  for (const raw of items) {
    const title = (raw.title ?? '').trim();
    if (title.length === 0) continue;
    const approxTraffic = parseApproxTraffic(firstString(raw.approxTraffic) || null);
    const pubDate = raw.pubDate ? raw.pubDate.trim() : null;
    const newsItems: GoogleTrendsNewsItem[] = [];
    for (const n of raw.newsItems ?? []) {
      const nTitle = firstString(n['ht:news_item_title']).trim();
      const nUrl = firstString(n['ht:news_item_url']).trim();
      const nSource = firstString(n['ht:news_item_source']).trim();
      if (nTitle.length === 0 || nUrl.length === 0) continue;
      if (nUrl.length > MAX_URL_CHARS) continue;
      newsItems.push({
        title: nTitle.slice(0, MAX_TITLE_CHARS),
        url: nUrl,
        source: nSource.slice(0, MAX_SOURCE_CHARS),
      });
    }
    out.push({
      title: title.slice(0, MAX_TITLE_CHARS),
      approxTraffic,
      pubDate,
      newsItems,
    });
  }
  return out.slice(0, MAX_ITEMS_PER_TICK);
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

interface InsertRow {
  readonly source: 'google_trends';
  readonly source_id: string;
  readonly payload: Record<string, unknown>;
}

/** Insert signals via upsert with ignoreDuplicates — cross-tick dedup
 *  via the unique(source,source_id) index from M1. */
async function insertSignals(
  deps: Parameters<JobHandler>[1],
  rows: ReadonlyArray<InsertRow>,
): Promise<{ attempted: number; failed: number }> {
  if (rows.length === 0) return { attempted: 0, failed: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('trend_signals')
    .upsert(rows as unknown as Record<string, unknown>[], {
      onConflict: 'source,source_id',
      ignoreDuplicates: true,
    })) as { error: { message: string } | null };
  if (error) {
    deps.logger.warn({
      event: 'google_trends_poll.insert_failed',
      message: scrubMessage(error.message),
      attempted: rows.length,
    });
    return { attempted: rows.length, failed: rows.length };
  }
  return { attempted: rows.length, failed: 0 };
}

/** Stamp the row's payload with the tick summary — same pattern as
 *  news-ingest. Observability for the operator-review digest. */
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
    deps.logger.debug({
      event: 'google_trends_poll.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

// ---------------------------------------------------------------------------
// Degrade sentinel
// ---------------------------------------------------------------------------

/** Write a single degraded-signal row so the composer can observe the
 *  gap. source_id is a per-tick marker — the composer treats
 *  payload.degraded as a signal to skip this source for the matched
 *  cluster window. Idempotent via source_id uniqueness. */
async function recordDegrade(
  deps: Parameters<JobHandler>[1],
  reason: string,
  tickMinute: string,
): Promise<void> {
  const row: InsertRow = {
    source: 'google_trends',
    source_id: `__degraded__:${tickMinute}`,
    payload: {
      degraded: true,
      reason: scrubMessage(reason).slice(0, 256),
      tick_minute: tickMinute,
    },
  };
  await insertSignals(deps, [row]);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Build the google_trends_poll handler. Factory pattern so tests can
 *  inject a fixed `now` and the fetch impl comes from deps.fetch. */
export function buildGoogleTrendsPollHandler(opts?: { readonly now?: () => Date }): JobHandler {
  const now = opts?.now ?? (() => new Date());
  return async function googleTrendsPollHandler(row: ScheduledJobRow, deps): Promise<void> {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('google_trends_poll: no fetch implementation available');
    }
    const startedAt = now();
    const tickMinute = startedAt.toISOString().slice(0, 16);

    let xml: string;
    try {
      xml = await fetchFeed(fetchImpl, GOOGLE_TRENDS_RSS_URL);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({
        event: 'google_trends_poll.fetch_failed',
        message,
      });
      await recordDegrade(deps, `fetch_failed: ${message}`, tickMinute);
      await stampPayload(deps, row.id, {
        ...row.payload,
        outcome: 'degraded_fetch',
        reason: message.slice(0, 256),
      });
      return;
    }

    let items: GoogleTrendsItem[];
    try {
      items = await parseGoogleTrendsRss(xml);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({
        event: 'google_trends_poll.parse_failed',
        message,
      });
      await recordDegrade(deps, `parse_failed: ${message}`, tickMinute);
      await stampPayload(deps, row.id, {
        ...row.payload,
        outcome: 'degraded_parse',
        reason: message.slice(0, 256),
      });
      return;
    }

    // source_id is `<normalized title>|<UTC hour bucket>` so the same
    // trend observed in two different hours produces two rows
    // (preserves the approx_traffic time series the heat composer's
    // 12h decay needs). Within one hour, upsert's ignoreDuplicates
    // collapses the four 15-min ticks into a single row (first-seen
    // wins). normalizeSourceIdTitle collapses whitespace + lowercases
    // so cosmetic variants of the same trend don't fork the bucket.
    const bucket = toUtcHourBucket(startedAt);
    const rows: InsertRow[] = items.map((it) => ({
      source: 'google_trends',
      source_id: `${normalizeSourceIdTitle(it.title)}|${bucket}`,
      payload: {
        title: it.title,
        approx_traffic: it.approxTraffic,
        pub_date: it.pubDate,
        news_items: it.newsItems,
        collected_at: startedAt.toISOString(),
        bucket_utc_hour: bucket,
      },
    }));

    const insertResult = await insertSignals(deps, rows);

    await stampPayload(deps, row.id, {
      ...row.payload,
      outcome: 'ok',
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
    });

    deps.logger.info({
      event: 'google_trends_poll.complete',
      jobId: row.id,
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

/** Default handler instance — registered in the scheduler. */
export const googleTrendsPollHandler: JobHandler = buildGoogleTrendsPollHandler();
