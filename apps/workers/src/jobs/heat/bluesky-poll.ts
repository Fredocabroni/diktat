// bluesky_trending_poll — polls Bluesky's public AppView unspecced
// endpoint `app.bsky.unspecced.getTrendingTopics` every 15 min via
// the scheduler spine and writes rows into public.trend_signals.
//
// Endpoint verified live against `https://public.api.bsky.app/xrpc/
// app.bsky.unspecced.getTrendingTopics?limit=10` on 2026-10-16:
// public, no auth required. Response schema (observed):
//
//   { topics: [{ topic, displayName, description, link }, …],
//     suggested: [], recIdStr }
//
// NOTE: the `unspecced` namespace means Bluesky may change or
// remove this endpoint without notice. The collector is schema-
// tolerant and degrades gracefully. A 7-day 404 fuse (to be added
// alongside a future retention worker; TODO) will auto-disable
// the collector if the endpoint goes dark.
//
// Gating: BLUESKY_ENABLED=false by default. The handler reads the
// env at tick time (same shape as GDELT_ENABLED). When off, the
// handler stamps outcome='disabled' and returns; no fetch happens.
//
// All signals are heat-only, service_role-only. No authenticated/
// anon write path exists on trend_signals.

import { scrubMessage } from '@diktat/shared/alerts';

import type { Database } from '@diktat/db';

import { loadEnv, type Env } from '../../env.js';
import type { JobHandler, ScheduledJobRow } from '../scheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BLUESKY_TRENDING_URL =
  'https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrendingTopics?limit=25';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS_PER_TICK = 50;
const MAX_TOPIC_CHARS = 128;
const MAX_DISPLAY_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_LINK_CHARS = 2048;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BlueskyTopic {
  readonly topic: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly link: string | null;
}

type TrendSignalInsert = Database['public']['Tables']['trend_signals']['Insert'];
type ScheduledJobsUpdate = Database['public']['Tables']['scheduled_jobs']['Update'];

// ---------------------------------------------------------------------------
// UTC-hour bucket (shared shape with google-trends-poll)
// ---------------------------------------------------------------------------

export function toUtcHourBucket(d: Date): string {
  return d.toISOString().slice(0, 13);
}

export function normalizeTopicForSourceId(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

async function fetchBody(fetchImpl: typeof globalThis.fetch, url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'diktat.app/heat-collector (contact ops@diktat.app)',
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`bluesky_trending_poll: fetch returned ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('bluesky_trending_poll: response has no readable body');
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
        throw new Error(`bluesky_trending_poll: body exceeded ${MAX_BODY_BYTES} bytes`);
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

function sanitizeString(v: unknown, cap: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.slice(0, cap);
}

/** Validated `link` — only http(s), length capped. */
function sanitizeLink(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > MAX_LINK_CHARS) return null;
  // Bluesky serves these as path-only (`/profile/x`) OR fully-
  // qualified. Accept both; reject anything that looks like a
  // non-http(s) scheme or an attempt at URL injection.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    // Scheme present — must be http(s).
    if (!/^https?:\/\//i.test(t)) return null;
  }
  return t;
}

export function parseBlueskyTrendingBody(body: string): BlueskyTopic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { topics?: unknown };
  if (!Array.isArray(obj.topics)) return [];
  const out: BlueskyTopic[] = [];
  for (const raw of obj.topics) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const topic = sanitizeString(r.topic, MAX_TOPIC_CHARS);
    if (!topic) continue;
    out.push({
      topic,
      displayName: sanitizeString(r.displayName, MAX_DISPLAY_NAME_CHARS),
      description: sanitizeString(r.description, MAX_DESCRIPTION_CHARS),
      link: sanitizeLink(r.link),
    });
    if (out.length >= MAX_ITEMS_PER_TICK) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Insert + stamp
// ---------------------------------------------------------------------------

interface InsertRow {
  readonly source: 'bluesky';
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
      event: 'bluesky_trending_poll.insert_failed',
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
      event: 'bluesky_trending_poll.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

async function recordDegrade(
  deps: Parameters<JobHandler>[1],
  reason: string,
  tickMinute: string,
): Promise<void> {
  const row: InsertRow = {
    source: 'bluesky',
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

export function buildBlueskyTrendingPollHandler(opts?: {
  readonly now?: () => Date;
  readonly envProvider?: () => Env;
}): JobHandler {
  const now = opts?.now ?? (() => new Date());
  const envProvider = opts?.envProvider ?? loadEnv;
  return async function blueskyTrendingPollHandler(row: ScheduledJobRow, deps): Promise<void> {
    const env = envProvider();
    const startedAt = now();
    const tickMinute = startedAt.toISOString().slice(0, 16);
    const bucket = toUtcHourBucket(startedAt);

    if (!env.BLUESKY_ENABLED) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'disabled',
      });
      deps.logger.info({ event: 'bluesky_trending_poll.disabled', jobId: row.id });
      return;
    }

    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('bluesky_trending_poll: no fetch implementation available');
    }

    let body: string;
    try {
      body = await fetchBody(fetchImpl, BLUESKY_TRENDING_URL);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({ event: 'bluesky_trending_poll.fetch_failed', message });
      await recordDegrade(deps, `fetch_failed: ${message}`, tickMinute);
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_fetch',
        reason: message.slice(0, 256),
      });
      return;
    }

    let items: BlueskyTopic[];
    try {
      items = parseBlueskyTrendingBody(body);
    } catch (err) {
      const message = scrubMessage(err instanceof Error ? err.message : String(err));
      deps.logger.warn({ event: 'bluesky_trending_poll.parse_failed', message });
      await recordDegrade(deps, `parse_failed: ${message}`, tickMinute);
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_parse',
        reason: message.slice(0, 256),
      });
      return;
    }

    const rows: InsertRow[] = items.map((t) => ({
      source: 'bluesky',
      source_id: `${normalizeTopicForSourceId(t.topic)}|${bucket}`,
      payload: {
        topic: t.topic,
        displayName: t.displayName,
        description: t.description,
        link: t.link,
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
      event: 'bluesky_trending_poll.complete',
      jobId: row.id,
      fetched: items.length,
      inserted_attempted: insertResult.attempted,
      inserted_failed: insertResult.failed,
      duration_ms: Date.now() - startedAt.getTime(),
    });
  };
}

export const blueskyTrendingPollHandler: JobHandler = buildBlueskyTrendingPollHandler();
