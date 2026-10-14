// news_ingest handler — polls primary-source feeds every 15 min via the
// scheduler spine and writes candidates into public.news_topics_candidates.
//
// V1 adapters: Congress.gov, BLS (Bureau of Labor Statistics), SEC EDGAR.
//
// SUBSTITUTION NOTE (2026-06-16): The founder spec named "congress, BLS,
// SCOTUS" as the three V1 adapters. SCOTUS publishes no clean RSS feed
// for opinions; the supremecourt.gov slip-opinions page is HTML-only
// and requires a custom scraper, which the scope guidance explicitly
// authorized deferring ("others can land in a follow-up if scope
// creeps"). SEC EDGAR substitutes — it has well-formed RSS, populates
// the sec_filings category already in the eleven V1 buckets, and lands
// the third adapter at V1 cost. SCOTUS HTML adapter is queued for V2
// alongside CDC, CBO, Census, DOJ, federalreserve.gov press releases,
// fred.stlouisfed.org, and the GDELT-filtered adapter.
//
// ADDICTION + integrity surfaces inside this handler:
//   - Every candidate URL is gated by classifyUrl() from
//     packages/ai-fabric/src/prompts/drop-sources.ts. Non-primary URLs
//     never land as primary_source_url on a Drop. The host classifier
//     is the §1 non-negotiable made structural.
//   - The handler does not rank, score, or de-duplicate beyond URL
//     canonicalization. Ranking is news_dedup_rank's job; the §2
//     transparent-math ranker lives there. This handler is intake.
//   - All adapter fetches go through the injected fetch impl so tests
//     can substitute without hitting the network.

import { scrubMessage } from '@diktat/shared/alerts';
import { unzipSync } from 'fflate';
import Parser from 'rss-parser';

import { classifyUrl, normalizeHost, type SourceCategory } from '@diktat/ai-fabric';
import { PAYWALL_FREE_PREFERRED_HOSTS } from '@diktat/shared/news-outlets';

import { loadEnv, type Env } from '../env.js';
import type { JobHandler } from './scheduler.js';

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/** Normalized candidate shape that every adapter returns. The handler
 *  inserts this directly into public.news_topics_candidates after
 *  classifying source_url. */
export interface CandidateInput {
  readonly source_provider: string;
  readonly source_category: SourceCategory;
  readonly source_title: string;
  readonly source_url: string;
  readonly source_host: string;
  readonly source_published_at: string | null; // ISO 8601
  readonly summary: string | null;
  readonly dedup_url_canon: string;
  /** Distinct-outlet count for the cluster at ingest time. Non-null
   *  for trending-source adapters (GDELT today, Grok + Reddit later);
   *  null for primary-source RSS adapters whose candidates don't
   *  carry a trending signal. Persisted to news_topics_candidates
   *  via migration 20261014000000. news-dedup-rank will bias
   *  rank_score on this in a follow-up PR. */
  readonly trend_score?: number | null;
  /** S1 evidence tier (migration 20261016000000). Defaults to
   *  'primary' at the DB level; adapters emitting reputable-tier
   *  candidates (GDELT after S1+S3) stamp 'reputable' here. */
  readonly evidence_tier?: 'primary' | 'direct' | 'reputable';
  /** AllSides v9 lean, present only when evidence_tier='reputable'. */
  readonly outlet_lean?: 'left' | 'lean-left' | 'center' | 'lean-right' | 'right' | null;
  /** 3-group collapse per operator spec; present only when
   *  evidence_tier='reputable'. */
  readonly outlet_group?: 'left' | 'center' | 'right' | null;
  /** News vs commentary. Commentary counts for trend_score + the S3
   *  balance signal, but is NEVER the card link on a Drop. Present
   *  only when evidence_tier='reputable'. */
  readonly outlet_type?: 'news' | 'commentary' | null;
  /** GDELT GLOBALEVENTID (joins to public.gdelt_event_cluster). Null
   *  for RSS adapters. */
  readonly global_event_id?: string | null;
}

/** Side-effect sinks the handler passes down to specific adapters.
 *  Optional per field — adapters that don't need a given sink leave
 *  it undefined (RSS adapters today, Grok tomorrow). The GDELT
 *  adapter uses `gdeltMentionSink` to feed the rolling-24h cluster
 *  state (public.gdelt_event_cluster + outlet) one mention at a time.
 *
 *  Keeping sinks on a dedicated parameter (rather than threading
 *  Supabase through the adapter contract) preserves the test seam —
 *  tests pass a vi.fn and verify the exact payload shape without
 *  needing a Supabase mock. */
export interface AdapterSinks {
  readonly gdeltMentionSink?: (m: GdeltMentionUpsert) => Promise<void>;
}

/** The per-mention payload the GDELT adapter emits to the cluster
 *  sink. Shape mirrors the gdelt_event_cluster + outlet columns the
 *  handler upserts. */
export interface GdeltMentionUpsert {
  readonly globalEventId: string;
  /** GDELT 2.0 EventTimeDate — `yyyyMMddHHmmss` UTC. */
  readonly eventTimeDate: string;
  readonly url: string;
  readonly host: string;
  readonly evidenceTier: 'primary' | 'direct' | 'reputable';
  /** Present only when evidenceTier='reputable'. */
  readonly outletLean?: 'left' | 'lean-left' | 'center' | 'lean-right' | 'right';
  readonly outletGroup?: 'left' | 'center' | 'right';
  readonly outletType?: 'news' | 'commentary';
  /** True when the host is in PAYWALL_FREE_PREFERRED_HOSTS (AP /
   *  Reuters / NPR / BBC / Axios / The Hill). Drop-publish uses this
   *  flag to pick the "best news URL" for the lazy text fetch. */
  readonly isPaywallFreePreferred: boolean;
}

/** Per-source adapter. Receives the fetch impl AND the validated Env
 *  from the handler closure. Returns the normalized candidate list;
 *  failures throw and the scheduler retries the whole news_ingest tick
 *  with backoff.
 *
 *  Env is threaded explicitly (security-reviewer PR #201 round 3 MED
 *  3.1) so no adapter ever reads `process.env` directly. The caller
 *  — `buildNewsIngestHandler` — loads env once per tick via
 *  `loadEnv()`, Zod-validates it, and passes the validated object
 *  down. Hot-reloads of env vars without process restart cannot
 *  toggle an adapter's feature flag without the Zod schema seeing
 *  the new value, and a future refactor cannot silently drop the
 *  gate because the gate variable is a function parameter, not a
 *  module-scope `process.env` read.
 *
 *  `sinks` is optional — pre-S1+S3 RSS adapters never set it. The
 *  GDELT adapter uses `sinks.gdeltMentionSink` for cross-tick
 *  cluster accumulation (public.gdelt_event_cluster + outlet). */
export interface NewsIngestAdapter {
  readonly name: string;
  readonly defaultCategory: SourceCategory;
  fetch(
    fetchImpl: typeof globalThis.fetch,
    env: Env,
    sinks?: AdapterSinks,
  ): Promise<CandidateInput[]>;
}

/** Hard cap on RSS feed body size — guards against a hostile or
 *  compromised primary-source feed shipping a multi-MB payload that
 *  would OOM the workers process. 10MB is well above any legitimate
 *  primary-source feed size (real feeds are tens-to-hundreds of KB). */
const MAX_FEED_BYTES = 10 * 1024 * 1024;

/** Per-HOP timeout, not per-CHAIN. AbortSignal.timeout(FETCH_TIMEOUT_MS)
 *  is re-created inside fetchWithSafeRedirects on every recursive call,
 *  so each redirect hop gets its own fresh 10s budget. Worst-case wall-
 *  clock for a full redirect chain is therefore (MAX_REDIRECTS + 1) ×
 *  FETCH_TIMEOUT_MS = 60s with the current values. The chain-deadline
 *  shape (one AbortSignal threaded through the whole chain) is logged
 *  in TYRION_BUILD_QUEUE as a follow-up; for V1 the per-hop budget is
 *  acceptable because legit primary-source CDNs reach 2xx on the first
 *  fetch and the recursive case is reserved for misbehaving servers
 *  that we'd rather kill quickly anyway. */
const FETCH_TIMEOUT_MS = 10_000;

/** Max redirects to follow per feed fetch. Five is generous for legit
 *  primary-source CDNs (typically 0–1 redirects); anything more is
 *  either a misconfigured server or an attacker-driven loop. */
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// URL canonicalization — the cheap first-pass dedup key.
// ---------------------------------------------------------------------------

/** Strip tracking params, lowercase host + path, strip trailing slash.
 *  Same canon string = same URL by the dedup_url_canon contract.
 *  Exposed for testing and reuse by the news_dedup_rank phase. */
export function canonicalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  // Strip common tracking + analytics params. Sort the remainder for stability.
  const TRACKING_PREFIXES = ['utm_', 'mc_', 'pk_'];
  const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'igshid', 'mkt_tok', 'ref', 'referrer']);
  const cleanParams = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PREFIXES.some((p) => k.toLowerCase().startsWith(p)))
    .filter(([k]) => !TRACKING_EXACT.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const search =
    cleanParams.length > 0 ? `?${cleanParams.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${u.protocol}//${host}${path}${search}`;
}

// ---------------------------------------------------------------------------
// RSS adapter — three V1 instances
// ---------------------------------------------------------------------------

/** Fetch a URL with hostname-validated redirect chasing. Defends against
 *  the security-reviewer's HIGH SSRF finding (2026-06-16): the original
 *  implementation used `redirect: 'follow'`, which let a primary-source
 *  CDN respond `302 Location: https://evil.com/...` and the workers
 *  process would dutifully fetch evil.com.
 *
 *  Behavior:
 *    - Pre-fetch: classifyUrl() on the URL. Non-primary host throws.
 *      This catches mis-configured adapters (a feed URL hardcoded as
 *      e.g. https://news.example.com/rss is rejected at the workers
 *      boundary, never makes a network request).
 *    - During fetch: redirect='manual' + AbortSignal.timeout. We see
 *      the 3xx ourselves rather than auto-following.
 *    - On 3xx: read Location, parse against the current URL (handles
 *      relative redirects), recurse with the same classification gate.
 *      Up to MAX_REDIRECTS deep.
 *    - On 2xx: return the Response for the caller to body-parse. */
async function fetchWithSafeRedirects(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  redirectCount = 0,
): Promise<Response> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`news_ingest: redirect chain too long (>${MAX_REDIRECTS}) starting at ${url}`);
  }
  const classification = classifyUrl(url);
  if (!classification.allowed || classification.role !== 'primary') {
    throw new Error(`news_ingest: refusing to fetch non-primary host: ${url}`);
  }

  const response = await fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`news_ingest: ${response.status} from ${url} carried no Location header`);
    }
    // Resolve relative URLs against the current URL.
    const nextUrl = new URL(location, url).toString();
    return fetchWithSafeRedirects(fetchImpl, nextUrl, redirectCount + 1);
  }

  return response;
}

/** Standard RSS parsing using rss-parser. Each adapter passes its feed
 *  URLs through this normalizer. */
async function fetchAndParseRss(
  fetchImpl: typeof globalThis.fetch,
  feedUrl: string,
): Promise<
  ReadonlyArray<{
    title: string;
    link: string;
    isoDate: string | null;
    contentSnippet: string | null;
  }>
> {
  const response = await fetchWithSafeRedirects(fetchImpl, feedUrl);
  if (!response.ok) {
    throw new Error(`news_ingest: feed ${feedUrl} returned ${response.status}`);
  }
  const xml = await response.text();
  // Bound the feed body. Primary-source RSS feeds are tens-to-hundreds
  // of KB; >10MB is either compromised or a billion-laughs probe.
  // security-reviewer ask, 2026-06-16.
  if (xml.length > MAX_FEED_BYTES) {
    throw new Error(
      `news_ingest: feed ${feedUrl} body ${xml.length} exceeds ${MAX_FEED_BYTES}B cap`,
    );
  }
  // rss-parser accepts a raw XML string via parseString.
  const parser = new Parser();
  const feed = await parser.parseString(xml);
  return (feed.items ?? [])
    .map((item) => ({
      title: (item.title ?? '').trim(),
      link: (item.link ?? '').trim(),
      isoDate: item.isoDate ?? null,
      contentSnippet: item.contentSnippet ?? item.content ?? null,
    }))
    .filter((it) => it.title.length > 0 && it.link.length > 0);
}

/** Build a CandidateInput from a parsed RSS item. Returns null if the
 *  item's URL fails parsing (defensive; rss-parser usually gives us
 *  well-formed URLs but the input is upstream) OR if the URL exceeds
 *  INGEST_MAX_URL_CHARS. source_title is truncated to
 *  INGEST_MAX_TITLE_CHARS. These length caps mirror the GDELT path
 *  (security-reviewer PR #207 round-1 LOW 3). */
function normalizeRssItem(opts: {
  provider: string;
  defaultCategory: SourceCategory;
  item: { title: string; link: string; isoDate: string | null; contentSnippet: string | null };
}): CandidateInput | null {
  if (opts.item.link.length > INGEST_MAX_URL_CHARS) return null;
  let host: string;
  try {
    host = normalizeHost(new URL(opts.item.link).hostname);
  } catch {
    return null;
  }
  return {
    source_provider: opts.provider,
    source_category: opts.defaultCategory,
    source_title: opts.item.title.slice(0, INGEST_MAX_TITLE_CHARS),
    source_url: opts.item.link,
    source_host: host,
    source_published_at: opts.item.isoDate,
    summary: opts.item.contentSnippet
      ? opts.item.contentSnippet.slice(0, INGEST_MAX_SUMMARY_CHARS)
      : null,
    dedup_url_canon: canonicalizeUrl(opts.item.link),
  };
}

/** Congress.gov adapter — pulls most-recent-bill activity feeds.
 *  Multiple feeds aggregated to capture both chambers. */
export const congressAdapter: NewsIngestAdapter = {
  name: 'congress',
  defaultCategory: 'congress',
  async fetch(fetchImpl, _env) {
    // The /rss/ feeds on congress.gov cover bill actions, committee
    // reports, and floor activity. V1 uses the introduced-bills feed
    // (one of the highest-signal sources of "something happened").
    const feeds = ['https://www.congress.gov/rss/most-viewed-bills.xml'];
    const all: CandidateInput[] = [];
    for (const url of feeds) {
      const items = await fetchAndParseRss(fetchImpl, url);
      for (const item of items) {
        const c = normalizeRssItem({ provider: 'congress', defaultCategory: 'congress', item });
        if (c) all.push(c);
      }
    }
    return all;
  },
};

/** BLS adapter — Bureau of Labor Statistics news releases RSS.
 *
 * Feed URL: `bls_latest.rss` is the aggregated "latest content" feed,
 * which is kept fresh across the full release calendar and is the
 * canonical RSS entry point advertised at bls.gov/schedule/. The
 * previous shape — `news_release.rss` — is the labor-market-release
 * sub-feed; it stops advancing between release cycles and silently
 * looked "dead" to the adapter during off-week stretches.
 * `bls_latest.rss` picks up every release the ingest cares about plus
 * routine content, which is what the drop pipeline wants (fresh
 * primary-source URLs, not just the headline NFP release).
 */
export const blsAdapter: NewsIngestAdapter = {
  name: 'bls',
  defaultCategory: 'bls_labor',
  async fetch(fetchImpl, _env) {
    const feeds = ['https://www.bls.gov/feed/bls_latest.rss'];
    const all: CandidateInput[] = [];
    for (const url of feeds) {
      const items = await fetchAndParseRss(fetchImpl, url);
      for (const item of items) {
        const c = normalizeRssItem({ provider: 'bls', defaultCategory: 'bls_labor', item });
        if (c) all.push(c);
      }
    }
    return all;
  },
};

/** SEC EDGAR adapter — substituting for SCOTUS in V1. EDGAR publishes
 *  a daily index of filings; the most recent-press-release-style feed
 *  is the cleanest entry point for Drop-shaped content (action took
 *  place, agency named, identifier present). */
export const secEdgarAdapter: NewsIngestAdapter = {
  name: 'sec_edgar',
  defaultCategory: 'sec_filings',
  async fetch(fetchImpl, _env) {
    const feeds = ['https://www.sec.gov/news/pressreleases.rss'];
    const all: CandidateInput[] = [];
    for (const url of feeds) {
      const items = await fetchAndParseRss(fetchImpl, url);
      for (const item of items) {
        const c = normalizeRssItem({ provider: 'sec_edgar', defaultCategory: 'sec_filings', item });
        if (c) all.push(c);
      }
    }
    return all;
  },
};

// ---------------------------------------------------------------------------
// GDELT trending adapter — Option B (data.gdeltproject.org raw export files)
// ---------------------------------------------------------------------------
//
// Replaces the api.gdeltproject.org DOC endpoint (104.197.47.124 on GCE
// us-central1) whose IPv4 TCP SYNs were silently dropped by Railway's
// egress. Cause confirmed 2026-10-13 via post-#211 cause-chain capture:
// UND_ERR_CONNECT_TIMEOUT after 10s on every tick from Railway, while
// the same URL + options from an operator laptop reached GDELT and got
// an HTTP 429 (rate-limit response — connection established fine).
// `dig AAAA api.gdeltproject.org` returned no record, so IPv6 was not
// the cause; this is a Railway→GCE peering issue specific to api's
// single-VM endpoint.
//
// data.gdeltproject.org is Google Cloud Storage (anycast / load-
// balanced front-ends; headers show `x-goog-*`, `UploadServer`), not a
// single GCE VM. GCS has much broader peering than individual Compute
// Engine VMs.
//
// Trade-off: raw export files don't carry article titles. We derive a
// best-effort title from the URL slug via humanizeUrlSlug(); Phase 2
// can enrich via secondary fetch or an AllSides/GDELT GKG join.

/** Hard-pinned GDELT data host. The adapter refuses to fetch any other
 *  host. Defense-in-depth: a future config bug can't accidentally point
 *  this adapter at an attacker-controlled URL. */
const GDELT_DATA_HOST = 'data.gdeltproject.org';

/** Pointer file published every 15 minutes. Body is a three-line
 *  text/plain response of the form:
 *      <size> <md5> http://data.gdeltproject.org/gdeltv2/<ts>.export.CSV.zip
 *      <size> <md5> http://data.gdeltproject.org/gdeltv2/<ts>.mentions.CSV.zip
 *      <size> <md5> http://data.gdeltproject.org/gdeltv2/<ts>.gkg.csv.zip
 *  Line 2 (mentions) is what we fetch next — one row per article
 *  mention of an event, with the source URL + domain. */
const GDELT_LASTUPDATE_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';

/** Per-fetch wall-clock timeout. 30 s is generous for a GCS fetch of a
 *  ~150 KB zip but tolerates a slow TLS handshake or TCP retransmit. */
const GDELT_FETCH_TIMEOUT_MS = 30_000;

/** Pointer file is ~320 B. Cap at 4 KiB to absorb any future format
 *  extension (new columns, pre-release markers) without being generous. */
const GDELT_LASTUPDATE_MAX_BYTES = 4 * 1024;

/** Compressed mentions.CSV.zip is typically 100-200 KB. 2 MiB cap is
 *  10× observed; above that is almost certainly a format change or a
 *  bomb payload. */
const GDELT_MENTIONS_ZIP_MAX_BYTES = 2 * 1024 * 1024;

/** Decompressed mentions.CSV typically 500 KB - 1 MB. 20 MiB cap bounds
 *  zip-bomb impact given the 2 MiB compressed input: worst-case
 *  decompression ratio before abort is 10×, well under memory. */
const GDELT_MENTIONS_CSV_MAX_BYTES = 20 * 1024 * 1024;

/** Hard cap on `mentions.length` the clusterer will process in one
 *  tick. A healthy 15-min window ships 2k-5k mentions; this cap guards
 *  against a schema change that bloats row count. */
const GDELT_MAX_MENTIONS = 50_000;

/** Minimum distinct-domain count below which the adapter will not surface
 *  a candidate. The operator's trend-score rule is "number of distinct
 *  outlets covering the same story in the window" — a one-source "story"
 *  has no trending signal, so we require ≥ 2. */
export const GDELT_MIN_TREND_SCORE = 2;

/** One parsed row of the GDELT 2.0 Mentions CSV (TSV, no header).
 *  Columns per https://www.gdeltproject.org/data.html#documentation :
 *   0: GLOBALEVENTID
 *   1: EventTimeDate (yyyyMMddHHmmss UTC)
 *   2: MentionTimeDate (yyyyMMddHHmmss UTC)
 *   3: MentionType
 *   4: MentionSourceName (domain)
 *   5: MentionIdentifier (URL)
 *   ...Confidence, DocLen, DocTone, ...
 *  We retain only the four fields we use. */
interface GdeltMention {
  readonly globalEventId: string;
  readonly eventTimeDate: string;
  readonly sourceName: string;
  readonly url: string;
}

/** Parse the second line of lastupdate.txt (the mentions pointer) and
 *  return a validated HTTPS URL on GDELT_DATA_HOST. Format tolerance:
 *  GDELT ships the URL as `http://...` in the pointer; we rewrite the
 *  scheme to https:// and refuse anything whose hostname is not
 *  GDELT_DATA_HOST (SSRF defense-in-depth). The path must match the
 *  canonical `/gdeltv2/<14-digit-ts>.mentions.CSV.zip` shape — anything
 *  else is a format drift. Returns null on any parse failure. */
export function extractMentionsUrl(lastupdate: string): string | null {
  const lines = lastupdate.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  // Format: "<size> <md5> <url>" — three whitespace-separated columns.
  // The URL may contain no whitespace per GDELT's naming convention.
  const parts = lines[1]!.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const rawUrl = parts[parts.length - 1]!;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== GDELT_DATA_HOST) return null;
  if (!/^\/gdeltv2\/\d{14}\.mentions\.CSV\.zip$/.test(parsed.pathname)) return null;
  // Rewrite http -> https. GDELT ships the pointer URLs as http but
  // GCS accepts https directly and redirects http->https anyway; dodging
  // the redirect saves one RTT and keeps the request on TLS from byte 1.
  parsed.protocol = 'https:';
  return parsed.toString();
}

/** SSRF-hardened fetch of a GDELT_DATA_HOST URL. Scheme/hostname pinned,
 *  `redirect='manual'` + any 3xx rejected, 30 s wall-clock timeout, body
 *  capped at `maxBytes` and returned as a Uint8Array. */
async function fetchGdeltBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gdelt: refusing to fetch malformed URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`gdelt: refusing non-https URL (scheme=${parsed.protocol})`);
  }
  if (parsed.hostname !== GDELT_DATA_HOST) {
    throw new Error(`gdelt: refusing non-GDELT host (${parsed.hostname})`);
  }

  const response = await fetchImpl(parsed.toString(), {
    redirect: 'manual',
    signal: AbortSignal.timeout(GDELT_FETCH_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `gdelt: refusing to follow redirect (${response.status}) from ${parsed.hostname}`,
    );
  }
  if (!response.ok) {
    throw new Error(`gdelt: HTTP ${response.status} from ${parsed.hostname}`);
  }
  return readBodyAsBytesWithSizeCap(response, maxBytes);
}

/** Read a Response body as a Uint8Array with an incremental size cap.
 *  Trips on the first chunk that would exceed `maxBytes`, cancels the
 *  reader, and throws. Security-reviewer PR #201 LOW. */
async function readBodyAsBytesWithSizeCap(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`gdelt: response body ${ab.byteLength} exceeds ${maxBytes}B cap`);
    }
    return new Uint8Array(ab);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`gdelt: response body exceeds ${maxBytes}B cap (streamed ${total}B)`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Scan the archive's EOCD (End Of Central Directory) record and return
 *  the entry count. Returns null if the EOCD is not found (malformed
 *  zip). The EOCD is 22 bytes at the end of a well-formed archive plus
 *  an optional 0–65535-byte trailing comment; we scan the trailing
 *  1 KiB only — a zip with a kilobyte+ trailing comment is suspicious
 *  on its own and worth rejecting. Round-2 reviewer MED 3: lets us
 *  enforce entry-count = 1 BEFORE `unzipSync` allocates per-entry
 *  decompressed buffers, closing the multi-entry memory-exhaustion
 *  path through the compressed-cap. */
function parseZipEntryCount(bytes: Uint8Array): number | null {
  const EOCD_SIG = 0x06054b50;
  if (bytes.length < 22) return null;
  const scanEnd = bytes.length - 22;
  const scanStart = Math.max(0, scanEnd - 1024);
  for (let i = scanEnd; i >= scanStart; i -= 1) {
    const sig =
      (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
    if (sig === EOCD_SIG) {
      // Offset 10-12 from EOCD start: total number of entries in the
      // central directory, uint16 little-endian.
      return bytes[i + 10]! | (bytes[i + 11]! << 8);
    }
  }
  return null;
}

/** Sanitize a zip entry filename before any use in error strings or
 *  log fields. Round-2 reviewer MED 4: an unsanitized name can carry
 *  path separators, null bytes, newlines, or ANSI escape sequences
 *  that corrupt log output or seed a path-traversal vector if the
 *  bytes are ever written to disk. We keep word chars, dots and
 *  dashes only; cap at 64 chars. */
function sanitizeZipEntryName(name: string): string {
  return name.replace(/[^\w.-]/g, '_').slice(0, 64);
}

/** Fetch the GDELT pointer file, parse out the mentions URL, fetch the
 *  mentions.CSV.zip, unzip, parse the TSV, return the mentions.
 *
 *  Zip-bomb bound: the compressed input is capped at
 *  GDELT_MENTIONS_ZIP_MAX_BYTES (2 MiB); the archive is pre-flighted
 *  via `parseZipEntryCount` to reject anything that is not a
 *  single-entry zip (closes the multi-entry memory-exhaustion path);
 *  after `unzipSync` the decompressed CSV is asserted ≤
 *  GDELT_MENTIONS_CSV_MAX_BYTES (20 MiB). Worst-case memory before
 *  abort: 22 MiB (single entry, 2 MiB compressed + 20 MiB decompressed).
 *
 *  The row cap (GDELT_MAX_MENTIONS = 50 000) is a second-layer defense
 *  against a well-formed-but-pathological CSV. */
async function fetchGdeltMentionsLatest(
  fetchImpl: typeof globalThis.fetch,
): Promise<GdeltMention[]> {
  // Step 1 — fetch pointer file. Routed through `fetchGdeltBytes` so
  // the scheme / host / redirect / timeout / size-cap guards all apply
  // to BOTH endpoints we hit (round-2 reviewer MED 1 — collapse the
  // abstraction gap so a future constant swap can't bypass the pin).
  const pointerBytes = await fetchGdeltBytes(
    fetchImpl,
    GDELT_LASTUPDATE_URL,
    GDELT_LASTUPDATE_MAX_BYTES,
  );
  const pointer = new TextDecoder('utf-8').decode(pointerBytes);

  // Step 2 — parse mentions URL out of the pointer.
  const mentionsUrl = extractMentionsUrl(pointer);
  if (mentionsUrl === null) {
    throw new Error(`gdelt: lastupdate.txt did not yield a valid mentions URL`);
  }

  // Step 3 — fetch the compressed CSV.
  const zipBytes = await fetchGdeltBytes(fetchImpl, mentionsUrl, GDELT_MENTIONS_ZIP_MAX_BYTES);

  // Step 4a — pre-flight the archive's entry count via EOCD without
  // allocating any decompressed buffer. GDELT's documented format is
  // exactly ONE entry per zip; anything else is a format drift or a
  // bomb payload. Round-2 reviewer MED 3.
  const entryCount = parseZipEntryCount(zipBytes);
  if (entryCount === null) {
    throw new Error(`gdelt: zip EOCD not found (malformed archive)`);
  }
  if (entryCount !== 1) {
    throw new Error(`gdelt: expected single-entry zip, got ${entryCount}`);
  }

  // Step 4b — unzip in-memory. With entry-count = 1 enforced above,
  // `unzipSync` allocates at most GDELT_MENTIONS_CSV_MAX_BYTES of
  // decompressed data in one buffer before the post-cap check fires.
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (err) {
    throw new Error(`gdelt: unzip failed (${(err as Error).message ?? 'unknown'})`);
  }
  const entries = Object.entries(unzipped);
  if (entries.length !== 1) {
    throw new Error(`gdelt: post-unzip entry count mismatch (got ${entries.length})`);
  }
  const [rawEntryName, csvBytes] = entries[0]!;
  const safeEntryName = sanitizeZipEntryName(rawEntryName);
  if (!/\.CSV$/i.test(safeEntryName)) {
    throw new Error(`gdelt: zip entry is not a .CSV (name=${safeEntryName})`);
  }
  if (csvBytes.byteLength > GDELT_MENTIONS_CSV_MAX_BYTES) {
    throw new Error(
      `gdelt: decompressed CSV ${csvBytes.byteLength} exceeds ${GDELT_MENTIONS_CSV_MAX_BYTES}B cap`,
    );
  }
  const csv = new TextDecoder('utf-8').decode(csvBytes);
  return parseGdeltMentionsCsv(csv);
}

/** Max hostname length (RFC 1035 — the per-label 63-byte cap times
 *  four labels is a comfortable upper bound on any real domain name). */
const INGEST_MAX_SOURCE_HOST_CHARS = 253;

/** Parse the GDELT Mentions TSV (no header). Each row is \t-separated;
 *  we read columns 0 (GLOBALEVENTID), 1 (EventTimeDate), 4
 *  (MentionSourceName), 5 (MentionIdentifier). Rows missing any
 *  required column are dropped. Rows with an oversized URL or source
 *  name are also dropped at parse time — this bounds per-row memory
 *  before the clusterer walks the array (round-2 reviewer LOW 2).
 *
 *  Row cap applies to ACCEPTED rows, not line index: a hostile CSV
 *  cannot push its true parse depth to zero by padding with blank
 *  lines (round-2 reviewer LOW 1). */
export function parseGdeltMentionsCsv(csv: string): GdeltMention[] {
  const out: GdeltMention[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (out.length >= GDELT_MAX_MENTIONS) break;
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const globalEventId = cols[0]!;
    const eventTimeDate = cols[1]!;
    const sourceName = cols[4]!;
    const url = cols[5]!;
    if (
      globalEventId.length === 0 ||
      eventTimeDate.length === 0 ||
      sourceName.length === 0 ||
      url.length === 0
    ) {
      continue;
    }
    // Parse-time length guards (round-2 reviewer LOW 2). A hostile CSV
    // row with an unbounded URL would otherwise sit in the clusterer's
    // input array until clusterGdeltMentions re-checks the cap.
    if (url.length > INGEST_MAX_URL_CHARS) continue;
    if (sourceName.length > INGEST_MAX_SOURCE_HOST_CHARS) continue;
    out.push({ globalEventId, eventTimeDate, sourceName, url });
  }
  return out;
}

/** Per-field length caps on ingest-adapter strings before DB insert
 *  (security-reviewer PR #201 round 3 MED 2.3 + LOW 2.4 + PR #207
 *  round-1 LOW 3). Applied in BOTH the GDELT path AND the RSS path
 *  via `normalizeRssItem` — PR #207 round-1 reviewer correctly flagged
 *  the earlier comment claiming "RSS adapters already apply equivalent
 *  caps" as factually wrong; only `summary` had a cap, not title / url.
 *  Both paths now share these constants and the defensive posture. */
const INGEST_MAX_TITLE_CHARS = 2000;
const INGEST_MAX_URL_CHARS = 2048;
const INGEST_MAX_SUMMARY_CHARS = 1000;

/** Humanize the final meaningful path segment of a URL into a readable
 *  title. GDELT Mentions CSV does not carry article titles; the old
 *  ArtList endpoint did. For launch, derive a best-effort title from
 *  the URL slug. Phase 2 can enrich via secondary HEAD fetch or GKG
 *  join.
 *
 *  Behavior:
 *   - take the last non-empty path segment ('/x/y/' → 'y')
 *   - strip a leading `<digits>.` or `<digits>-` prefix (article IDs)
 *   - strip a trailing extension (.html, .pdf, …)
 *   - split on dashes/underscores/dots, trim each token
 *   - uppercase first letter of each token
 *   - join with single spaces, cap at INGEST_MAX_TITLE_CHARS
 *   - fall back to `<host> event <GLOBALEVENTID-shortened>` when the
 *     slug produces nothing readable (<3 chars) — never emit empty. */
export function humanizeUrlSlug(url: string, fallbackHost: string, fallbackId: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return `${fallbackHost} event ${fallbackId.slice(0, 10)}`;
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  const stripped = last.replace(/^\d+\./, '').replace(/\.(html?|pdf|aspx?|php|md)$/i, '');
  const tokens = stripped
    .split(/[-_.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  const title = tokens.join(' ').trim();
  if (title.length < 3) {
    return `${fallbackHost} event ${fallbackId.slice(0, 10)}`;
  }
  return title.slice(0, INGEST_MAX_TITLE_CHARS);
}

/** Group mentions by GLOBALEVENTID and produce one CandidateInput per
 *  event whose first primary-source URL passes classifyUrl().
 *
 *  Trend score is "distinct outlets covering the same event in the
 *  window". A group of mentions sharing a GLOBALEVENTID is the same
 *  semantic cluster the old title-based clustering approximated —
 *  GDELT has already linked these mentions to one underlying event.
 *
 *  Clusters whose outlet count is below GDELT_MIN_TREND_SCORE are
 *  dropped.
 *
 *  Security-reviewer PR #201 round-3 LOW 5.3 trust-of-GDELT note still
 *  applies: a hostile upstream could inflate a cluster's score by
 *  posting many fake non-primary domains under one event id. The
 *  trust assumption is: GDELT's own corpus-ingestion pipeline makes
 *  the domain field reliable enough as a trending signal. If this
 *  ever changes, revisit by switching to a primary-only count AND
 *  lowering GDELT_MIN_TREND_SCORE to 1 so the Drop pool doesn't shrink. */
export async function clusterGdeltMentions(
  mentions: GdeltMention[],
  sinks?: AdapterSinks,
): Promise<CandidateInput[]> {
  type Group = { readonly domains: Set<string>; readonly rows: GdeltMention[] };
  const groups = new Map<string, Group>();
  const sink = sinks?.gdeltMentionSink;
  for (const m of mentions) {
    // Feed the cluster-upsert sink for every ALLOWED mention. Classify
    // once; use the result below. This propagates to the handler's
    // Supabase upsert of gdelt_event_cluster + outlet (migration
    // 20261016000000). Non-allowed mentions are not sunk — they would
    // never be eligible for the Drop pool anyway.
    if (sink) {
      const cls = classifyUrl(m.url);
      if (cls.allowed) {
        try {
          const host = normalizeHost(new URL(m.url).hostname);
          const isReputable = cls.role === 'reputable';
          await sink({
            globalEventId: m.globalEventId,
            eventTimeDate: m.eventTimeDate,
            url: m.url,
            host,
            evidenceTier: cls.evidence_tier,
            outletLean: isReputable ? cls.outlet_lean : undefined,
            outletGroup: isReputable ? cls.outlet_group : undefined,
            outletType: isReputable ? cls.outlet_type : undefined,
            isPaywallFreePreferred: PAYWALL_FREE_PREFERRED_HOSTS.includes(host),
          });
        } catch {
          // URL parse / sink throw → fire-and-forget; cluster upsert
          // is observability + Drop-pool enrichment, not critical path.
        }
      }
    }

    const existing = groups.get(m.globalEventId);
    if (existing) {
      existing.domains.add(m.sourceName.toLowerCase());
      existing.rows.push(m);
    } else {
      const domains = new Set<string>();
      domains.add(m.sourceName.toLowerCase());
      groups.set(m.globalEventId, { domains, rows: [m] });
    }
  }

  const out: CandidateInput[] = [];
  for (const [eventId, group] of groups) {
    const trendScore = group.domains.size;
    if (trendScore < GDELT_MIN_TREND_SCORE) continue;

    // Pick the best-tier allowed mention from this event. Priority:
    //   1. primary / direct (tier='primary' from classifyUrl)
    //   2. reputable (tier='reputable') — S1+S3 widening
    // Everything else is skipped. (Non-allowed URLs don't reach the
    // handler; the handler would also reject them, but filtering here
    // keeps the adapter output tight.)
    let picked: GdeltMention | null = null;
    let pickedClassification: ReturnType<typeof classifyUrl> | null = null;
    // First pass: primary.
    for (const m of group.rows) {
      const classification = classifyUrl(m.url);
      if (classification.allowed && classification.role === 'primary') {
        picked = m;
        pickedClassification = classification;
        break;
      }
    }
    // Second pass: reputable fallback.
    if (picked === null) {
      for (const m of group.rows) {
        const classification = classifyUrl(m.url);
        if (classification.allowed && classification.role === 'reputable') {
          picked = m;
          pickedClassification = classification;
          break;
        }
      }
    }
    if (!picked || pickedClassification === null) continue;
    if (!pickedClassification.allowed) continue;

    // Length cap BEFORE the scheme-assert URL parse.
    if (picked.url.length > INGEST_MAX_URL_CHARS) continue;
    const parsedUrl = requireHttpsUrl(picked.url);
    if (parsedUrl === null) continue;
    const host = normalizeHost(parsedUrl.hostname);

    const title = humanizeUrlSlug(picked.url, host, eventId);

    // Narrow the classification shape for TS: only 'reputable' carries
    // the outlet triple. The pickedClassification.role check already
    // narrowed to the allowed-true union above.
    const outletLean =
      pickedClassification.role === 'reputable' ? pickedClassification.outlet_lean : null;
    const outletGroup =
      pickedClassification.role === 'reputable' ? pickedClassification.outlet_group : null;
    const outletType =
      pickedClassification.role === 'reputable' ? pickedClassification.outlet_type : null;
    out.push({
      source_provider: 'gdelt',
      source_category: pickedClassification.category,
      source_title: title,
      source_url: picked.url,
      source_host: host,
      source_published_at: parseGdeltMentionsDate(picked.eventTimeDate),
      // Legacy prefix kept so a downstream renderer reading `summary`
      // sees the trend context (same shape as the pre-rewrite output).
      summary: `[trend=${trendScore}] ${group.rows.length} mention(s) across ${trendScore} outlet(s).`,
      dedup_url_canon: canonicalizeUrl(picked.url),
      trend_score: trendScore,
      // S1+S3 stamps.
      evidence_tier: pickedClassification.evidence_tier,
      outlet_lean: outletLean,
      outlet_group: outletGroup,
      outlet_type: outletType,
      global_event_id: eventId,
    });
  }

  // Sort by trend_score descending so the ranker sees the highest-signal
  // clusters first. Equal scores: stable order (first-seen wins).
  out.sort((a, b) => (b.trend_score ?? 0) - (a.trend_score ?? 0));
  return out;
}

/** Parse a URL string and return the parsed URL ONLY if its scheme is
 *  https:. Non-string input, malformed URL, or any other scheme →
 *  null. Caller treats null as "drop this candidate".
 *
 *  Security-reviewer PR #201 round 3 MED 7.2: the storage-boundary
 *  scheme assertion in the clusterer was coupled to `classifyUrl`'s
 *  internal scheme-strictness. This helper decouples it so the
 *  invariant lives at the clusterer and can be tested in isolation. */
function requireHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === 'https:' ? u : null;
}

/** Parse the GDELT Mentions 14-digit date format back to an ISO 8601
 *  string. Format: `yyyyMMddHHmmss` (UTC). Returns null on failure. */
function parseGdeltMentionsDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** Minimum interval between successive GDELT fetches, in milliseconds.
 *  The 15-min scheduler cadence is well above this bar; the module-
 *  local gate catches a misconfigured tick cadence (e.g. a future PR
 *  shortening ticks to 1-minute cadence) before it hammers GCS. Reset
 *  to 0 on process start — the first tick after deploy always runs. */
const GDELT_MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let gdeltLastFetchAt = 0;

/** GDELT trending adapter — Option B. Only runs when `env.GDELT_ENABLED`
 *  is true. Env flows in through `NewsIngestAdapter.fetch` from the
 *  handler closure — the adapter never reads `process.env` directly. */
export const gdeltAdapter: NewsIngestAdapter = {
  name: 'gdelt',
  defaultCategory: 'congress', // overridden per-article by classifyUrl.
  async fetch(fetchImpl, env, sinks) {
    if (!env.GDELT_ENABLED) return [];
    const now = Date.now();
    if (now - gdeltLastFetchAt < GDELT_MIN_FETCH_INTERVAL_MS) {
      return [];
    }
    gdeltLastFetchAt = now;
    const mentions = await fetchGdeltMentionsLatest(fetchImpl);
    return clusterGdeltMentions(mentions, sinks);
  },
};

/** V1 adapter registry. Future PRs append; the handler iterates. */
export const DEFAULT_ADAPTERS: ReadonlyArray<NewsIngestAdapter> = [
  congressAdapter,
  blsAdapter,
  secEdgarAdapter,
  gdeltAdapter,
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Outcome stamped into the row's payload for diagnostics. */
interface IngestSummary {
  readonly adapter: string;
  readonly fetched: number;
  readonly inserted: number;
  readonly rejected_host_not_allowed: number;
  readonly rejected_framing: number;
  readonly rejected_invalid: number;
  readonly errors: number;
  readonly error_message?: string;
}

/** 24-hour threshold for the "feed looks dead" warn. The adapter's
 *  `last_fresh_insert_at` moves forward every time it produces at least
 *  one candidate that passes the (source_provider, source_url) dedup
 *  check — a dead feed stops advancing it even though adapter.fetch
 *  itself still succeeds. 24h is deliberately generous: BLS off-weeks,
 *  congressional recesses, SEC filing lulls all produce multi-hour
 *  gaps on healthy feeds. A full day of silence on an inherently high-
 *  volume primary source is signal, not noise. */
const STALE_FRESH_WARN_MS = 24 * 60 * 60 * 1000;

/** Build the news_ingest handler. Factory pattern so tests can inject
 *  an alternate adapter list AND a hand-crafted `Env` stub without
 *  needing every workers-env var (DATABASE_URL, SUPABASE_URL, ...) to
 *  be present at test time.
 *
 *  Prod flow: `buildNewsIngestHandler()` is called at scheduler-build
 *  time without args → `envProvider` defaults to `loadEnv`. At tick
 *  time, the returned JobHandler calls `envProvider()` once to get the
 *  validated Env snapshot, then threads it to every adapter. The
 *  per-tick load lets us pick up Railway env rotations without a
 *  process restart but still through the Zod validation.
 *
 *  Test flow: tests pass a stub `envProvider: () => fakeEnv as Env`
 *  that returns a hand-crafted minimal Env. Each gdelt-adapter test
 *  can toggle `GDELT_ENABLED` on that stub without touching
 *  `process.env`. */
export function buildNewsIngestHandler(
  adapters: ReadonlyArray<NewsIngestAdapter> = DEFAULT_ADAPTERS,
  envProvider: () => Env = loadEnv,
): JobHandler {
  return async function newsIngestHandler(row, deps) {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('news_ingest: no fetch implementation available');
    }

    // Load + validate env ONCE per tick. Every adapter.fetch call
    // receives the same validated snapshot — no mid-tick env drift.
    const env = envProvider();

    const summaries: IngestSummary[] = [];
    for (const adapter of adapters) {
      summaries.push(await ingestOne(adapter, fetchImpl, env, deps));
    }

    const totalInserted = summaries.reduce((s, x) => s + x.inserted, 0);
    const totalRejected = summaries.reduce(
      (s, x) => s + x.rejected_host_not_allowed + x.rejected_framing + x.rejected_invalid,
      0,
    );

    // Stamp the per-adapter summary into the row's payload. Source
    // risk_push row stays untouched. Same pattern as push_deliver.
    await stampPayload(deps, row.id, {
      ...row.payload,
      ingest_summary: summaries,
      ingest_total_inserted: totalInserted,
      ingest_total_rejected: totalRejected,
    });

    // Fire 24h-dedup warn for any adapter whose last FRESH insert is
    // >= STALE_FRESH_WARN_MS ago. news_adapter_health.last_fresh_insert_at
    // is written by ingestOne above whenever an adapter produced ≥1 fresh
    // row; stale-feed conditions (e.g. the BLS off-week bug that drove
    // this instrumentation) hold it still. Rendered as warn, not error,
    // because a single 24h stretch of silence is signal to a human but
    // not grounds to page an on-call.
    await warnStaleAdapters(deps);

    deps.logger.info({
      event: 'news_ingest.complete',
      jobId: row.id,
      inserted: totalInserted,
      rejected: totalRejected,
      adapters: summaries.map((s) => ({
        name: s.adapter,
        fetched: s.fetched,
        inserted: s.inserted,
      })),
    });
  };
}

/** Read every row of public.news_adapter_health; emit a warn log for
 *  any adapter whose last_fresh_insert_at is >24h ago (or has never
 *  produced a fresh insert at all AND the row was created ≥24h ago).
 *  A read failure is swallowed with a debug log — observability must
 *  never crash the ingest tick. */
async function warnStaleAdapters(deps: Parameters<JobHandler>[1]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (deps.supabase as any)
    .from('news_adapter_health')
    .select('adapter, last_success_at, last_fresh_insert_at, updated_at')) as {
    data:
      | {
          adapter: string;
          last_success_at: string | null;
          last_fresh_insert_at: string | null;
          updated_at: string;
        }[]
      | null;
    error: { message: string } | null;
  };
  if (error) {
    deps.logger.debug({
      event: 'news_ingest.health_read_failed',
      message: error.message,
    });
    return;
  }
  const now = Date.now();
  for (const row of data ?? []) {
    const freshMs = row.last_fresh_insert_at ? Date.parse(row.last_fresh_insert_at) : null;
    const createdMs = Date.parse(row.updated_at);
    // Warn when:
    //   (a) there IS a last-fresh timestamp and it's older than 24h, OR
    //   (b) there is NO last-fresh timestamp AND the row has existed ≥24h
    //       (a brand-new adapter row avoids a spurious cold-start warn).
    const stale =
      (freshMs !== null && now - freshMs >= STALE_FRESH_WARN_MS) ||
      (freshMs === null && now - createdMs >= STALE_FRESH_WARN_MS);
    if (!stale) continue;
    deps.logger.warn({
      event: 'news_ingest.adapter_stale',
      adapter: row.adapter,
      last_success_at: row.last_success_at,
      last_fresh_insert_at: row.last_fresh_insert_at,
      stale_threshold_ms: STALE_FRESH_WARN_MS,
    });
  }
}

/** Walk an Error's `cause` chain and produce a `":"-joined` summary
 *  of each layer's `message` (or `code`, when present — undici
 *  attaches `code` on its network-layer errors). Node's `undici`
 *  wraps the real failure as `TypeError('fetch failed', { cause:
 *  { code: 'ECONNRESET', ... } })`; the operator-facing bare
 *  `fetch failed` string is useless without the cause chain surfaced.
 *
 *  Caps at 5 levels (defensive against pathological cycles) and
 *  flattens through scrubMessage per layer. PR #210-sibling fold:
 *  surface the real reason GDELT fetches are failing on Railway
 *  (observed on 2026-10-13: adapter-health err_180 was just the
 *  bare "fetch failed" string with no actionable detail). */
function errorChainMessage(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth += 1) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      // Cap at 64 chars so a long/attacker-controlled `code` cannot blow
      // out the Telegram body or the DB column. All Node/undici error
      // codes seen in the wild are short tokens (ECONNRESET, ENOTFOUND,
      // UND_ERR_SOCKET, …) — 64 is comfortably past the longest documented.
      const codeStr = typeof code === 'string' && code.length > 0 ? code.slice(0, 64) : '';
      const msg = cur.message || cur.name || 'Error';
      parts.push(scrubMessage(codeStr ? `${msg} [${codeStr}]` : msg));
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(scrubMessage(String(cur)));
      break;
    }
  }
  return parts.join(' <- ');
}

/** Run one adapter, classify each candidate, insert into the staging
 *  table. Returns a summary; errors are caught and stamped (one bad
 *  adapter doesn't kill the whole tick). */
async function ingestOne(
  adapter: NewsIngestAdapter,
  fetchImpl: typeof globalThis.fetch,
  env: Env,
  deps: Parameters<JobHandler>[1],
): Promise<IngestSummary> {
  let candidates: CandidateInput[];
  // Per-adapter sinks. The GDELT adapter uses `gdeltMentionSink` to
  // feed the rolling-24h cluster state (public.gdelt_event_cluster +
  // outlet) one mention at a time. RSS adapters don't use any sink.
  const sinks: AdapterSinks = {
    gdeltMentionSink:
      adapter.name === 'gdelt' ? (m) => upsertGdeltEventMention(deps, m) : undefined,
  };
  try {
    candidates = await adapter.fetch(fetchImpl, env, sinks);
  } catch (err) {
    // Surface the whole cause chain, not just `err.message`. Undici's
    // `fetch failed` message is useless without the inner cause.
    const message = errorChainMessage(err);
    deps.logger.warn({
      event: 'news_ingest.adapter_failed',
      adapter: adapter.name,
      message,
    });
    // Stamp the failure into news_adapter_health. last_success_at /
    // last_fresh_insert_at are deliberately NOT touched — the health
    // view relies on their held-still state to drive the staleness
    // warn above.
    await upsertAdapterHealth(deps, adapter.name, {
      lastErrorAt: new Date().toISOString(),
      // Cap at 1024 before DB write. The chain is already bounded (5
      // layers × scrubMessage output), but a pathological cause-chain
      // payload could still oversize the operator-facing text column.
      // 1024 leaves generous room past the Telegram body's 400-char cap
      // so DB retains more context than the alert itself.
      lastErrorMessage: message.slice(0, 1024),
      lastFetchedCount: 0,
      lastFreshCount: 0,
    });
    // Telegram alert, per-adapter dedup (1 hour TTL). Catches the
    // silent-failure class #194 was built for but on the adapter
    // path rather than drop-publish. Fire-and-forget so a Telegram
    // outage never kills the ingest tick. Static body stub: the
    // chain message in the warn log is the full context; the
    // alerter sees an operator-facing pointer plus the chain so
    // Telegram alone reveals the real reason.
    void deps.alerter?.alert(
      'error',
      `news_ingest adapter_failed:${adapter.name}`,
      `adapter=${adapter.name} · ${message.slice(0, 400)}`,
      {
        dedupKey: `news_ingest:adapter_failed:${adapter.name}`,
        dedupTtlMs: 60 * 60_000,
      },
    );
    return {
      adapter: adapter.name,
      fetched: 0,
      inserted: 0,
      rejected_host_not_allowed: 0,
      rejected_framing: 0,
      rejected_invalid: 0,
      errors: 1,
      error_message: message,
    };
  }

  let inserted = 0;
  let rejectedHost = 0;
  let rejectedFraming = 0;
  let rejectedInvalid = 0;

  for (const c of candidates) {
    // Reject URLs carrying userinfo (https://evil.com@congress.gov/...)
    // before classification. The URL's hostname IS congress.gov by spec
    // — classifyUrl would (correctly) classify it as primary — but when
    // rendered in the UI most browsers navigate following the userinfo
    // path, sending the user to evil.com's server. Cheap defense in
    // depth (security-reviewer ask, 2026-06-16). Legit primary-source
    // feeds never embed userinfo.
    let hasUserinfo = false;
    try {
      const u = new URL(c.source_url);
      hasUserinfo = u.username.length > 0 || u.password.length > 0;
    } catch {
      // URL parse failure flows through classifyUrl's invalid branch.
    }
    if (hasUserinfo) {
      rejectedInvalid += 1;
      await insertCandidate(deps, c, 'invalid_payload');
      continue;
    }

    const classification = classifyUrl(c.source_url);

    if (classification.allowed) {
      // Allowed URL — insert as active candidate. Use the adapter's
      // declared category (which may be more specific than the
      // classifier's bucket — both come from the same allow-list).
      const ok = await insertCandidate(deps, c, null);
      if (ok) inserted += 1;
    } else if (classification.role === 'framing') {
      // Ban-list host — defensive log; primary-source feeds should
      // never return ban-list URLs. Persist as rejected for audit.
      rejectedFraming += 1;
      await insertCandidate(deps, c, 'host_not_allowed');
    } else if (classification.role === 'invalid') {
      rejectedInvalid += 1;
      await insertCandidate(deps, c, 'invalid_payload');
    } else {
      // 'rejected' — non-allow-list host. Same audit shape.
      rejectedHost += 1;
      await insertCandidate(deps, c, 'host_not_allowed');
    }
  }

  // Stamp success + any fresh-insert advancement into the health
  // table. `last_fresh_insert_at` only advances when inserted > 0 so
  // a dead feed (fetch succeeds, dedup absorbs everything) does NOT
  // keep refreshing the staleness clock — which is exactly the
  // condition the 24h warn is designed to catch.
  const nowIso = new Date().toISOString();
  await upsertAdapterHealth(deps, adapter.name, {
    lastSuccessAt: nowIso,
    lastFreshInsertAt: inserted > 0 ? nowIso : undefined,
    lastFetchedCount: candidates.length,
    lastFreshCount: inserted,
  });

  return {
    adapter: adapter.name,
    fetched: candidates.length,
    inserted,
    rejected_host_not_allowed: rejectedHost,
    rejected_framing: rejectedFraming,
    rejected_invalid: rejectedInvalid,
    errors: 0,
  };
}

/** Fields the health UPSERT accepts. All optional: a success path
 *  passes lastSuccessAt + optional lastFreshInsertAt; a failure path
 *  passes lastErrorAt + lastErrorMessage; nothing on either path
 *  touches a column it doesn't own. */
interface HealthUpsert {
  readonly lastSuccessAt?: string;
  readonly lastFreshInsertAt?: string;
  readonly lastErrorAt?: string;
  readonly lastErrorMessage?: string;
  readonly lastFetchedCount: number;
  readonly lastFreshCount: number;
}

/** UPSERT the per-adapter health row.
 *
 * The handler owns updated_at (not a trigger) so a test can assert
 * against it without a DB round-trip and we don't need a separate
 * trigger migration. onConflict is the primary key (adapter).
 *
 * We build the UPSERT payload by starting from the existing row's
 * success/fresh timestamps and only overwriting them when the current
 * call carries fresh values — a failure row MUST NOT clear
 * last_success_at, and a success-but-no-fresh row MUST NOT clear
 * last_fresh_insert_at. Using supabase.from(...).upsert() alone
 * can't express the merge; we SELECT first then INSERT ... ON
 * CONFLICT DO UPDATE via the client's upsert().
 */
async function upsertAdapterHealth(
  deps: Parameters<JobHandler>[1],
  adapterName: string,
  patch: HealthUpsert,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = deps.supabase as any;

  // Read the prior row so we can preserve the columns the current
  // branch doesn't touch. A missing row (brand-new adapter) is fine —
  // defaults handle it.
  const { data: prior } = (await sb
    .from('news_adapter_health')
    .select('last_success_at, last_fresh_insert_at, last_error_at, last_error_message')
    .eq('adapter', adapterName)
    .maybeSingle()) as {
    data: {
      last_success_at: string | null;
      last_fresh_insert_at: string | null;
      last_error_at: string | null;
      last_error_message: string | null;
    } | null;
  };

  const row = {
    adapter: adapterName,
    last_success_at: patch.lastSuccessAt ?? prior?.last_success_at ?? null,
    last_fresh_insert_at: patch.lastFreshInsertAt ?? prior?.last_fresh_insert_at ?? null,
    last_error_at: patch.lastErrorAt ?? prior?.last_error_at ?? null,
    last_error_message: patch.lastErrorMessage ?? prior?.last_error_message ?? null,
    last_fetched_count: patch.lastFetchedCount,
    last_fresh_count: patch.lastFreshCount,
    updated_at: new Date().toISOString(),
  };

  const { error } = (await sb
    .from('news_adapter_health')
    .upsert(row, { onConflict: 'adapter' })) as { error: { message: string } | null };

  if (error) {
    // Observability — never fail the ingest tick on a health-table
    // write. debug (not warn) because an operator wouldn't normally
    // want to see this; a persistent failure here would be caught
    // by the stale-warn above (which depends on reads working, so a
    // completely broken table surfaces anyway).
    deps.logger.debug({
      event: 'news_ingest.health_upsert_failed',
      adapter: adapterName,
      message: error.message,
    });
  }
}

/** Upsert one GDELT mention into the rolling-24h cluster state
 *  (public.gdelt_event_cluster + public.gdelt_event_cluster_outlet)
 *  via the atomic SECURITY DEFINER RPC `upsert_gdelt_event_mention`.
 *
 *  The RPC does BOTH writes in a single SQL statement set with
 *  ON CONFLICT DO UPDATE and COALESCE on `primary_url` /
 *  `best_news_url` so the first-seen value wins under concurrent
 *  ticks. Closes PR #214 round-1 reviewer MED 3 (TOCTOU race
 *  between a two-step upsert+update pattern).
 *
 *  Fire-and-forget on error. The cluster state is observability +
 *  Drop-pool enrichment, not the critical path. A failed call logs
 *  but never breaks the ingest tick. */
async function upsertGdeltEventMention(
  deps: Parameters<JobHandler>[1],
  m: GdeltMentionUpsert,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (deps.supabase as any).rpc('upsert_gdelt_event_mention', {
      p_global_event_id: m.globalEventId,
      p_url: m.url,
      p_host: m.host,
      p_evidence_tier: m.evidenceTier,
      p_outlet_lean: m.outletLean ?? null,
      p_outlet_group: m.outletGroup ?? null,
      p_outlet_type: m.outletType ?? null,
      p_is_paywall_free_preferred: m.isPaywallFreePreferred,
    });
    if (error) {
      deps.logger.warn({
        event: 'news_ingest.gdelt_cluster_upsert_failed',
        global_event_id: m.globalEventId,
        message: scrubMessage((error as { message?: string }).message ?? 'unknown'),
      });
    }
  } catch (err) {
    deps.logger.warn({
      event: 'news_ingest.gdelt_cluster_upsert_threw',
      global_event_id: m.globalEventId,
      message: errorChainMessage(err),
    });
  }
}

/** Idempotent insert via ON CONFLICT(source_provider, source_url) DO
 *  NOTHING. Returns true if a new row was inserted, false if the
 *  unique constraint absorbed it. */
async function insertCandidate(
  deps: Parameters<JobHandler>[1],
  c: CandidateInput,
  rejectedReason: string | null,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any).from('news_topics_candidates').insert({
    source_provider: c.source_provider,
    source_category: c.source_category,
    source_title: c.source_title,
    source_url: c.source_url,
    source_host: c.source_host,
    source_published_at: c.source_published_at,
    summary: c.summary,
    dedup_url_canon: c.dedup_url_canon,
    // Nullable column from migration 20261014000000. RSS adapters
    // leave this null; trending-source adapters (GDELT today) write
    // the distinct-outlet count. news-dedup-rank reads it in a
    // follow-up PR to bias rank_score.
    trend_score: c.trend_score ?? null,
    // S1 label stamps (migration 20261016000000). evidence_tier
    // defaults to 'primary' at the DB level; adapters pre-S1+S3 (RSS
    // primary-source feeds) don't set it. GDELT adapter stamps
    // 'reputable' or 'primary' depending on which URL it picked.
    evidence_tier: c.evidence_tier ?? undefined,
    outlet_lean: c.outlet_lean ?? null,
    outlet_group: c.outlet_group ?? null,
    outlet_type: c.outlet_type ?? null,
    global_event_id: c.global_event_id ?? null,
    rejected_reason: rejectedReason,
  })) as { error: { code?: string; message: string } | null };

  if (error) {
    // 23505 = unique_violation on (source_provider, source_url) — expected
    // for re-ingested feed items. NOT an error condition.
    if (error.code === '23505') return false;
    deps.logger.warn({
      event: 'news_ingest.insert_failed',
      provider: c.source_provider,
      url: c.source_url,
      message: scrubMessage(error.message),
    });
    return false;
  }
  return true;
}

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
    throw new Error(`news_ingest: stamp payload: ${scrubMessage(error.message)}`);
  }
}

/** Reset the module-local GDELT rate-limit cursor. Test-only; call
 *  from beforeEach / afterEach so one test's successful fetch doesn't
 *  starve the next test for 5 minutes of wall-clock time. */
function resetGdeltRateLimitState(): void {
  gdeltLastFetchAt = 0;
}

export const __testing = {
  canonicalizeUrl,
  normalizeRssItem,
  fetchAndParseRss,
  requireHttpsUrl,
  resetGdeltRateLimitState,
  errorChainMessage,
  upsertGdeltEventMention,
  INGEST_MAX_TITLE_CHARS,
  INGEST_MAX_URL_CHARS,
  GDELT_MIN_FETCH_INTERVAL_MS,
};
