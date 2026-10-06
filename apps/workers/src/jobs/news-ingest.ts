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

import Parser from 'rss-parser';

import { classifyUrl, normalizeHost, type SourceCategory } from '@diktat/ai-fabric';

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
}

/** Per-source adapter. Receives the fetch impl from HandlerDeps;
 *  returns the normalized candidate list. Failures throw — the
 *  scheduler retries the whole news_ingest tick with backoff. */
export interface NewsIngestAdapter {
  readonly name: string;
  readonly defaultCategory: SourceCategory;
  fetch(fetchImpl: typeof globalThis.fetch): Promise<CandidateInput[]>;
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
 *  well-formed URLs but the input is upstream). */
function normalizeRssItem(opts: {
  provider: string;
  defaultCategory: SourceCategory;
  item: { title: string; link: string; isoDate: string | null; contentSnippet: string | null };
}): CandidateInput | null {
  let host: string;
  try {
    host = normalizeHost(new URL(opts.item.link).hostname);
  } catch {
    return null;
  }
  return {
    source_provider: opts.provider,
    source_category: opts.defaultCategory,
    source_title: opts.item.title,
    source_url: opts.item.link,
    source_host: host,
    source_published_at: opts.item.isoDate,
    summary: opts.item.contentSnippet ? opts.item.contentSnippet.slice(0, 1000) : null,
    dedup_url_canon: canonicalizeUrl(opts.item.link),
  };
}

/** Congress.gov adapter — pulls most-recent-bill activity feeds.
 *  Multiple feeds aggregated to capture both chambers. */
export const congressAdapter: NewsIngestAdapter = {
  name: 'congress',
  defaultCategory: 'congress',
  async fetch(fetchImpl) {
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
  async fetch(fetchImpl) {
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
  async fetch(fetchImpl) {
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

/** V1 adapter registry. Future PRs append; the handler iterates. */
export const DEFAULT_ADAPTERS: ReadonlyArray<NewsIngestAdapter> = [
  congressAdapter,
  blsAdapter,
  secEdgarAdapter,
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
 *  an alternate adapter list (e.g. a single fake adapter). */
export function buildNewsIngestHandler(
  adapters: ReadonlyArray<NewsIngestAdapter> = DEFAULT_ADAPTERS,
): JobHandler {
  return async function newsIngestHandler(row, deps) {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('news_ingest: no fetch implementation available');
    }

    const summaries: IngestSummary[] = [];
    for (const adapter of adapters) {
      summaries.push(await ingestOne(adapter, fetchImpl, deps));
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

/** Run one adapter, classify each candidate, insert into the staging
 *  table. Returns a summary; errors are caught and stamped (one bad
 *  adapter doesn't kill the whole tick). */
async function ingestOne(
  adapter: NewsIngestAdapter,
  fetchImpl: typeof globalThis.fetch,
  deps: Parameters<JobHandler>[1],
): Promise<IngestSummary> {
  let candidates: CandidateInput[];
  try {
    candidates = await adapter.fetch(fetchImpl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
      lastErrorMessage: message,
      lastFetchedCount: 0,
      lastFreshCount: 0,
    });
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
      message: error.message,
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
    throw new Error(`news_ingest: stamp payload: ${error.message}`);
  }
}

export const __testing = { canonicalizeUrl, normalizeRssItem, fetchAndParseRss };
