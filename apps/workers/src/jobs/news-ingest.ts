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
import Parser from 'rss-parser';

import { classifyUrl, normalizeHost, type SourceCategory } from '@diktat/ai-fabric';

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
 *  module-scope `process.env` read. */
export interface NewsIngestAdapter {
  readonly name: string;
  readonly defaultCategory: SourceCategory;
  fetch(fetchImpl: typeof globalThis.fetch, env: Env): Promise<CandidateInput[]>;
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
// GDELT trending adapter (PR fix/gdelt-ingestor)
// ---------------------------------------------------------------------------

/** Hard-pinned GDELT API host. The adapter refuses to fetch any other host.
 *  Defense-in-depth: a future config bug can't accidentally point this
 *  adapter at an attacker-controlled URL. */
const GDELT_API_HOST = 'api.gdeltproject.org';
/** Three empirically-verified GDELT API gotchas (PR #205 round 1 after
 *  the post-deploy verification turned up zero candidates):
 *   1. `timespan=15min` returns HTTP 200 with the text body
 *      `"Timespan is too short."`. GDELT's smallest supported window
 *      is `1h`. The 15-min cadence of our scheduler means consecutive
 *      ticks see overlapping windows; the clusterer's `dedup_url_canon`
 *      unique insert absorbs the overlap.
 *   2. `maxrecords=250` is above GDELT's default (75) and seems to
 *      count as a "larger query" per the 429 response body
 *      ("contact kalev.leetaru5@gmail.com for larger queries"). Backed
 *      off to 75.
 *   3. GDELT's 429 is slow — ~9-10s before the 429 lands. See
 *      FETCH_TIMEOUT_MS below. */
const GDELT_API_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcecountry%3AUS%20sourcelang%3Aeng%20(domain%3Agov%20OR%20theme%3AUSCOURTS%20OR%20theme%3ATRIAL)&mode=ArtList&format=json&sort=HybridRel&maxrecords=75&timespan=1h';

/** GDELT-specific timeout. The RSS adapters use FETCH_TIMEOUT_MS (10s)
 *  which is tight. GDELT responses — even the 200-OK happy path — land
 *  in the 8-11s range in practice, and the 429 rate-limit response
 *  takes ~9s to arrive. 30s gives both the happy path AND the
 *  rate-limited retry room to complete. Still bounded well under the
 *  15-minute scheduler cadence. */
const GDELT_FETCH_TIMEOUT_MS = 30_000;

/** Max response body size from the GDELT API. Legitimate ArtList JSON for
 *  75 records tops out around 150 KB; the 2MB cap is far above that while
 *  still bounding OOM risk. */
const GDELT_MAX_BYTES = 2 * 1024 * 1024;

/** Hard cap on `response.articles.length` the clusterer will process in
 *  one tick. GDELT_API_URL hardcodes `maxrecords=75`, so a well-behaved
 *  response fits inside this cap. Guards against a hostile or
 *  misconfigured upstream response that ships thousands of entries:
 *  without this cap, the O(N) grouping + per-article regex in
 *  gdeltTitleKey would run on every entry before the 60-char slice.
 *  Security-reviewer PR #201 MEDIUM. */
const GDELT_MAX_ARTICLES = 500;

/** GDELT returns some error responses as HTTP 200 with a text/plain
 *  body (e.g. `"Timespan is too short."` or the "larger queries" text
 *  on a 429 occasionally served as 200). We assert content-type on
 *  the response before attempting JSON.parse so an operator sees a
 *  clean "unexpected content-type" error instead of a confusing JSON
 *  parse-failure message that embeds the error prose. */
const GDELT_EXPECTED_CONTENT_TYPE_PREFIX = 'application/json';

/** Minimum distinct-domain count below which the adapter will not surface
 *  a candidate. The operator's trend-score rule is "number of distinct
 *  outlets covering the same story in the window" — a one-source "story"
 *  has no trending signal, so we require ≥ 2. */
export const GDELT_MIN_TREND_SCORE = 2;

/** Shape of the GDELT ArtList article we care about. Extra fields are
 *  ignored — the parser stays lenient so a future field addition doesn't
 *  break ingestion. */
interface GdeltArticle {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly seendate?: unknown;
  readonly domain?: unknown;
  readonly language?: unknown;
  readonly sourcecountry?: unknown;
}

interface GdeltResponse {
  readonly articles?: unknown;
}

/** SSRF-hardened GDELT API fetch. Scoped tighter than fetchWithSafeRedirects:
 *   - only https://api.gdeltproject.org/… is allowed
 *   - redirect='manual' + any 3xx is rejected (GDELT API does not redirect)
 *   - 30s per-hop timeout (GDELT API latency is 8-11s even on happy
 *     path; see GDELT_FETCH_TIMEOUT_MS comment).
 *   - response body hard-capped at GDELT_MAX_BYTES
 *   - Content-Type must start with application/json; GDELT returns
 *     some errors as 200 OK with a text/plain body (observed:
 *     "Timespan is too short.", rate-limit prose). PR #205.
 *  Error strings use `parsed.hostname` (not `parsed.host`) for
 *  consistency with the hostname guard (security-reviewer PR #201
 *  round-4 LOW).
 *  The three-layer SSRF guard requested in the overnight-run brief
 *  (scheme allowlist https, no private IPs/localhost, no redirects to
 *  them) is enforced at the host-string level — this adapter never
 *  resolves user-supplied URLs so an IP-literal / RFC1918 target cannot
 *  reach the fetch call. */
async function fetchGdeltArtList(
  fetchImpl: typeof globalThis.fetch,
  url: string,
): Promise<GdeltResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gdelt: refusing to fetch malformed URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`gdelt: refusing non-https URL (scheme=${parsed.protocol})`);
  }
  if (parsed.hostname !== GDELT_API_HOST) {
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

  // Content-Type assertion (PR #205). GDELT returns some errors as
  // HTTP 200 with a text/plain body. Example: `timespan=15min` returns
  // "Timespan is too short." with 200 OK. JSON.parse would throw a
  // confusing error that embeds the error prose; a clean Content-Type
  // check surfaces the real problem.
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith(GDELT_EXPECTED_CONTENT_TYPE_PREFIX)) {
    throw new Error(
      `gdelt: unexpected content-type "${contentType}" from ${parsed.hostname} ` +
        `(expected ${GDELT_EXPECTED_CONTENT_TYPE_PREFIX})`,
    );
  }

  // Stream-read with early size cap (security-reviewer PR #201 LOW):
  // `await response.text()` buffers the full body before any size check,
  // so a slow upstream shipping 100 MB would OOM the workers process
  // before the 2 MB gate below ever fired. Reading via the ReadableStream
  // reader lets us trip the cap mid-stream and cancel the body.
  const body = await readBodyWithSizeCap(response, GDELT_MAX_BYTES);
  try {
    return JSON.parse(body) as GdeltResponse;
  } catch {
    throw new Error(`gdelt: response body is not valid JSON`);
  }
}

/** Read a Response body as text with an incremental size cap. Trips on
 *  the FIRST chunk that would exceed `maxBytes`, cancels the reader so
 *  the connection is released, and throws. Falls back to
 *  `response.text()` only when `response.body` is unavailable (which
 *  shouldn't happen in Node 20+ but is defensive against polyfilled
 *  fetch impls in test shims). Security-reviewer PR #201 LOW. */
async function readBodyWithSizeCap(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const buffered = await response.text();
    if (buffered.length > maxBytes) {
      throw new Error(`gdelt: response body ${buffered.length} exceeds ${maxBytes}B cap`);
    }
    return buffered;
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
  // Concat Uint8Array chunks into one, then decode UTF-8.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/** Normalize a GDELT article title for similarity-based clustering.
 *  Lowercase + drop non-alphanumeric + take the first 60 chars. Two
 *  articles about the same event tend to share the first 60 chars of
 *  their title after this normalization even when outlets re-caption
 *  (e.g. prepending "Breaking:" or appending " – Reuters"). */
export function gdeltTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 60);
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

/** From a GDELT ArtList response, cluster articles by title similarity
 *  and produce one CandidateInput per cluster whose primary URL passes
 *  classifyUrl().
 *
 *  Trend score is "distinct outlets covering the same story in the
 *  window" per the operator's design doc
 *  (docs/phase-5/trending-sources-2026-10-11.md). Security-reviewer
 *  round-3 LOW 5.3 flagged that this counts raw GDELT `a.domain`
 *  values — a hostile GDELT supplier could inflate a cluster's score
 *  by posting many fake non-primary domains under one title. The
 *  reviewer offered two remediations: (a) scope the count to primary-
 *  source domains, OR (b) document the current behavior as an
 *  intentional trust-of-GDELT decision. (a) would diverge from the
 *  operator's design doc semantics; (b) is the chosen path. The
 *  trust assumption is: GDELT's own corpus-ingestion pipeline + the
 *  `sourcecountry:US sourcelang:eng` filter make the domain field
 *  reliable enough as a trending signal. If this ever changes,
 *  revisit by switching to a primary-only count AND lowering
 *  `GDELT_MIN_TREND_SCORE` to 1 so the Drop pool doesn't shrink.
 *
 *  Clusters whose outlet count is below GDELT_MIN_TREND_SCORE are
 *  dropped.
 *
 *  The `[trend=N]` prefix in `summary` is a legacy pre-column-add
 *  carrier; TODO(gdelt-cleanup): remove once news-dedup-rank reads the
 *  dedicated `trend_score` column directly (security-reviewer round-3
 *  LOW round-4). */
export function clusterGdeltArticles(response: GdeltResponse): CandidateInput[] {
  // Hard cap on how many entries the clusterer will walk in one tick
  // (security-reviewer PR #201 MEDIUM). The GDELT API URL already asks
  // for maxrecords=75, so a well-behaved response fits inside the cap;
  // a misconfigured or hostile upstream shipping thousands of entries
  // is clipped before gdeltTitleKey's per-article regex ever runs.
  const rawFull = Array.isArray(response.articles) ? response.articles : [];
  const raw = rawFull.slice(0, GDELT_MAX_ARTICLES);
  // group articles by titleKey → { domains: Set, articles: GdeltArticle[] }
  type Group = { readonly domains: Set<string>; readonly articles: GdeltArticle[] };
  const groups = new Map<string, Group>();
  for (const a of raw as GdeltArticle[]) {
    if (typeof a?.title !== 'string' || typeof a?.url !== 'string') continue;
    const key = gdeltTitleKey(a.title);
    if (key.length === 0) continue;
    const existing = groups.get(key);
    if (existing) {
      if (typeof a.domain === 'string') existing.domains.add(a.domain.toLowerCase());
      existing.articles.push(a);
    } else {
      const domains = new Set<string>();
      if (typeof a.domain === 'string') domains.add(a.domain.toLowerCase());
      groups.set(key, { domains, articles: [a] });
    }
  }

  const out: CandidateInput[] = [];
  for (const [, group] of groups) {
    const trendScore = group.domains.size;
    if (trendScore < GDELT_MIN_TREND_SCORE) continue;

    // Find the first article in the cluster whose URL passes classifyUrl()
    // as a primary source. Articles are returned by GDELT in HybridRel
    // order (most trending first), so the first primary we find is the
    // best-signal primary for the cluster. Capture the classification
    // from this single call and reuse below (security-reviewer round-4
    // LOW: previously a redundant second classifyUrl call looked like
    // a post-scheme-check re-validation).
    let primary: GdeltArticle | null = null;
    let primaryClassification: ReturnType<typeof classifyUrl> | null = null;
    for (const a of group.articles) {
      if (typeof a.url !== 'string') continue;
      const classification = classifyUrl(a.url);
      if (classification.allowed && classification.role === 'primary') {
        primary = a;
        primaryClassification = classification;
        break;
      }
    }
    if (!primary || typeof primary.url !== 'string' || typeof primary.title !== 'string') continue;
    if (primaryClassification === null) continue; // narrower for TS
    if (!primaryClassification.allowed || primaryClassification.role !== 'primary') continue;

    // Length caps BEFORE the scheme-assert URL parse — a hostile upstream
    // could ship a 100 KB URL string that passes classifyUrl's hostname
    // suffix match but inflates index + TOAST storage.
    if (primary.url.length > INGEST_MAX_URL_CHARS) continue;
    const title = primary.title.slice(0, INGEST_MAX_TITLE_CHARS);

    // Scheme assertion (security-reviewer PR #201 round 3 MED 7.2):
    // `classifyUrl` currently rejects non-https schemes at its own
    // first gate, but relying on that single layer couples a storage-
    // boundary invariant to the host-classifier's internals. Assert
    // the scheme explicitly here so a future `classifyUrl` change
    // that loosens scheme-strictness cannot silently open a stored-
    // XSS path through `source_url`.
    const parsedUrl = requireHttpsUrl(primary.url);
    if (parsedUrl === null) continue;
    const host = normalizeHost(parsedUrl.hostname);

    out.push({
      source_provider: 'gdelt',
      source_category: primaryClassification.category,
      source_title: title,
      source_url: primary.url,
      source_host: host,
      source_published_at:
        typeof primary.seendate === 'string' ? parseGdeltSeenDate(primary.seendate) : null,
      // TODO(gdelt-cleanup): remove the `[trend=N]` prefix once
      // news-dedup-rank reads the dedicated `trend_score` column
      // directly. Kept now so a future consumer that renders `summary`
      // doesn't see a bare "N article(s)…" line without the trend
      // context, and so the ranker's current prefix-regex still works.
      summary: `[trend=${trendScore}] ${group.articles.length} article(s) across ${trendScore} outlet(s).`,
      dedup_url_canon: canonicalizeUrl(primary.url),
      // Dedicated numeric column added by migration 20261014000000.
      // Written on every GDELT-emitted candidate.
      trend_score: trendScore,
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
 *  scheme assertion in `clusterGdeltArticles` was coupled to
 *  `classifyUrl`'s internal scheme-strictness. This helper decouples
 *  it so the invariant lives at the clusterer and can be tested in
 *  isolation. */
function requireHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === 'https:' ? u : null;
}

/** Parse GDELT's YYYYMMDDTHHMMSSZ format back to an ISO 8601 string.
 *  Returns null on any parse failure. */
function parseGdeltSeenDate(s: string): string | null {
  // Format: 20261010T053000Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** GDELT trending adapter. Only runs when `env.GDELT_ENABLED` is true —
 *  same gated-shadow-ship pattern as PRIVY_ENABLED / FACT_CHECK_ENABLED.
 *  The adapter is wired into DEFAULT_ADAPTERS so its health row appears
 *  in news_adapter_health immediately; a flag-off tick records a
 *  success with 0 fetched.
 *
 *  Env flows in through the `NewsIngestAdapter.fetch` signature from
 *  the handler closure — the adapter NEVER reads `process.env`
 *  directly. The validated Zod `Env` object is the single source of
 *  truth for feature-flag state (security-reviewer PR #201 round 3
 *  MED 3.1). boolFromString in `envSchema` normalises 'true'/'True'/
 *  'TRUE' to boolean `true` and everything else to `false`, so a
 *  Railway env hot-reload cannot bypass validation. */
/** Minimum interval between successive GDELT fetches, in milliseconds
 *  (PR #205 fold-in of security-reviewer round-3 LOW 6.2). GDELT's
 *  public API documents a 1-request-per-5-second rate limit and
 *  additionally serves "larger queries" with a slow 429. The
 *  scheduler's 15-min cadence is well above this bar; the module-
 *  local gate catches a misconfigured tick cadence (e.g. a future PR
 *  shortening the scheduler to 1-minute ticks) before it hammers the
 *  upstream. Reset to 0 on process start — the first tick after
 *  deploy always runs.
 *
 *  NOTE for future consumers: any downstream job that fetches
 *  `news_topics_candidates.source_url` from GDELT-sourced rows MUST
 *  independently re-validate the host allowlist AND the https scheme
 *  — do not trust the stored value. The storage-boundary guards
 *  (classifyUrl + requireHttpsUrl) run at ingest time; a URL that
 *  later becomes unreachable or is swapped at the destination is NOT
 *  re-verified on read. Security-reviewer round-3 LOW 1.2. */
const GDELT_MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let gdeltLastFetchAt = 0;

export const gdeltAdapter: NewsIngestAdapter = {
  name: 'gdelt',
  defaultCategory: 'congress', // overridden per-article by classifyUrl.
  async fetch(fetchImpl, env) {
    if (!env.GDELT_ENABLED) return [];
    const now = Date.now();
    if (now - gdeltLastFetchAt < GDELT_MIN_FETCH_INTERVAL_MS) {
      // Short-circuit without touching the network. Returning [] is
      // operationally indistinguishable from "no new candidates this
      // tick" — adapter health still records a successful tick.
      return [];
    }
    gdeltLastFetchAt = now;
    const response = await fetchGdeltArtList(fetchImpl, GDELT_API_URL);
    return clusterGdeltArticles(response);
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
  try {
    candidates = await adapter.fetch(fetchImpl, env);
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
  INGEST_MAX_TITLE_CHARS,
  INGEST_MAX_URL_CHARS,
  GDELT_MIN_FETCH_INTERVAL_MS,
};
