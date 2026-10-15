import { zipSync, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  buildNewsIngestHandler,
  clusterGdeltMentions,
  extractMentionsUrl,
  gdeltAdapter,
  GDELT_MIN_TREND_SCORE,
  humanizeUrlSlug,
  parseGdeltMentionsCsv,
  type CandidateInput,
  type NewsIngestAdapter,
} from '../../src/jobs/news-ingest.js';
import type { Env } from '../../src/env.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

/** Hand-crafted minimal Env for tests. Avoids a full `loadEnv()` seed
 *  (DATABASE_URL / SUPABASE_URL / UPSTASH_* would all be required
 *  otherwise). Tests that care about GDELT_ENABLED produce a fresh
 *  stub via `envWith({ GDELT_ENABLED: true })`. */
const BASE_STUB_ENV: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
  UPSTASH_REDIS_REST_URL: 'https://r.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'tk',
  PRIVY_ENABLED: false,
  PRIVY_APP_ID: '',
  PRIVY_APP_SECRET: '',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: '',
  GDELT_ENABLED: false,
};
function envWith(overrides: Partial<Env>): Env {
  return { ...BASE_STUB_ENV, ...overrides };
}
const STUB_ENV_PROVIDER = (): Env => BASE_STUB_ENV;

const { canonicalizeUrl, fetchAndParseRss } = __testing;

// ---------------------------------------------------------------------------
// canonicalizeUrl — the cheap first-pass dedup key
// ---------------------------------------------------------------------------

describe('canonicalizeUrl', () => {
  it('lowercases the host and strips www.', () => {
    expect(canonicalizeUrl('https://WWW.Congress.GOV/bill/118HR1234')).toBe(
      'https://congress.gov/bill/118hr1234',
    );
  });

  it('strips a trailing slash on a non-root path', () => {
    expect(canonicalizeUrl('https://bls.gov/news.release/')).toBe('https://bls.gov/news.release');
  });

  it('keeps the root slash when path is just "/"', () => {
    expect(canonicalizeUrl('https://congress.gov/')).toBe('https://congress.gov/');
  });

  it('strips utm_*, fbclid, gclid tracking params', () => {
    expect(
      canonicalizeUrl(
        'https://congress.gov/bill/1?utm_source=email&utm_medium=email&fbclid=abc&id=42',
      ),
    ).toBe('https://congress.gov/bill/1?id=42');
  });

  it('sorts remaining params for stable canonicalization', () => {
    expect(canonicalizeUrl('https://sec.gov/path?b=2&a=1')).toBe('https://sec.gov/path?a=1&b=2');
  });

  it('produces identical canon for query-equivalent URLs', () => {
    const a = canonicalizeUrl('https://www.bls.gov/news.release/?utm_source=x&utm_medium=y');
    const b = canonicalizeUrl('https://bls.gov/news.release');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// fetchAndParseRss — redirect host validation (SSRF defense)
// ---------------------------------------------------------------------------

describe('fetchAndParseRss — redirect host validation', () => {
  // Minimal RSS body, returned on 200 to satisfy the parser when a test
  // exercises a happy redirect-followed-to-an-allow-list-host case.
  const RSS_OK = `<?xml version="1.0"?><rss version="2.0"><channel><title>ok</title><item><title>x</title><link>https://www.congress.gov/bill/1</link></item></channel></rss>`;

  it('rejects a 302 redirect to a non-allow-list host (the SSRF case)', async () => {
    // Hardcoded primary-source feed URL respondes with 302 to evil.com.
    // The workers process must NOT issue the follow-up fetch.
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'https://www.congress.gov/rss/feed.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.com/feed.xml' },
        });
      }
      // If this branch fires, the SSRF defense failed.
      throw new Error(`unexpected follow-up fetch to ${u}`);
    });

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.congress.gov/rss/feed.xml'),
    ).rejects.toThrow(/refusing to fetch non-primary host: https:\/\/evil\.com/);

    // Hard assertion: only ONE fetch was made — the original. The
    // redirect was never followed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a 301 redirect to a ban-listed host (CNN as framing-only)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'https://www.bls.gov/feed/news_release.rss') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://www.cnn.com/politics/rss' },
        });
      }
      throw new Error(`unexpected follow-up fetch to ${u}`);
    });

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.bls.gov/feed/news_release.rss'),
    ).rejects.toThrow(/refusing to fetch non-primary host: https:\/\/www\.cnn\.com/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a 301 redirect WITHIN the allow-list (e.g. www.bls.gov → bls.gov)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'https://www.bls.gov/feed/news_release.rss') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://bls.gov/feed/news_release.rss' },
        });
      }
      if (u === 'https://bls.gov/feed/news_release.rss') {
        return new Response(RSS_OK, { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });

    const items = await fetchAndParseRss(
      fetchImpl as never,
      'https://www.bls.gov/feed/news_release.rss',
    );
    expect(items.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an infinite redirect loop (>MAX_REDIRECTS)', async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      return new Response(null, {
        status: 302,
        // Same-host redirect chain; allow-list passes each time but
        // the depth cap kills the loop.
        headers: { location: `https://www.congress.gov/rss/feed-${count}.xml` },
      });
    });

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.congress.gov/rss/feed-0.xml'),
    ).rejects.toThrow(/redirect chain too long/);
  });

  it('rejects 3xx with no Location header (malformed redirect)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: {} }));

    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://www.sec.gov/news/pressreleases.rss'),
    ).rejects.toThrow(/302 from .* carried no Location header/);
  });

  it('refuses to fetch a non-allow-list feed URL at all (pre-fetch host gate)', async () => {
    // Defense in depth — if a future adapter is misconfigured with a
    // non-primary feed URL, the host gate blocks the request entirely.
    const fetchImpl = vi.fn();
    await expect(
      fetchAndParseRss(fetchImpl as never, 'https://news.example.com/rss'),
    ).rejects.toThrow(/refusing to fetch non-primary host: https:\/\/news\.example\.com/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Handler — adapter iteration + classification + insert
// ---------------------------------------------------------------------------

interface FakeState {
  inserted: Record<string, unknown>[];
  insertedRejected: Record<string, unknown>[];
  payloadUpdates: { id: string; patch: Record<string, unknown> }[];
  insertError: { code?: string; message: string } | null;
  /** news_adapter_health upserts (adapter → latest payload). The handler
   *  calls upsert on every tick; the Map models the PK on `adapter`. */
  healthUpserts: Map<string, Record<string, unknown>>;
  /** Prior-row snapshot the handler reads via
   *  `select(...).eq('adapter', name).maybeSingle()` before each upsert.
   *  Tests can prime this to simulate a pre-existing adapter row (e.g.
   *  to verify the fresh-at timestamp carries forward across a dead
   *  tick without being cleared). */
  healthPriors: Map<string, Record<string, unknown>>;
  /** Rows the handler's bulk-read `select(...)` returns for the
   *  warnStaleAdapters pass. Separate from `healthPriors` because the
   *  terminal select and the eq()-filtered select serve different
   *  code paths. */
  healthBulkRows: Record<string, unknown>[];
}

function buildSupabase(state: FakeState): ServiceClient {
  return {
    from: (table: string) => {
      // news_adapter_health has a different write shape (upsert instead
      // of insert) and two read shapes (eq-filtered single + terminal
      // bulk). Model each explicitly rather than through the generic
      // from() shape so the test doesn't accidentally conflate paths.
      if (table === 'news_adapter_health') {
        return {
          select: (_cols: string) => {
            // Terminal thenable (await supabase.from(...).select(...))
            // returns the bulk rows for warnStaleAdapters, AND
            // .eq('adapter', name).maybeSingle() returns the prior-row
            // snapshot for upsertAdapterHealth.
            return {
              eq: (col: string, val: unknown) => ({
                maybeSingle: () => {
                  const data =
                    col === 'adapter' ? (state.healthPriors.get(String(val)) ?? null) : null;
                  return Promise.resolve({ data, error: null });
                },
              }),
              then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
                resolve({ data: state.healthBulkRows, error: null }),
            };
          },
          upsert: (row: Record<string, unknown>, _opts?: unknown) => {
            state.healthUpserts.set(String(row.adapter), row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        insert: (row: Record<string, unknown>) => {
          // Mirror Postgres: an error response means the row did NOT land.
          // Only record successful inserts in state.inserted / state.insertedRejected.
          if (table === 'news_topics_candidates' && state.insertError === null) {
            if (row.rejected_reason) state.insertedRejected.push(row);
            else state.inserted.push(row);
          }
          return Promise.resolve({ error: state.insertError });
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: unknown) => {
            if (table === 'scheduled_jobs') {
              state.payloadUpdates.push({ id: String(id), patch });
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  } as unknown as ServiceClient;
}

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

function row(): ScheduledJobRow {
  return {
    id: 'job-1',
    job_type: 'news_ingest',
    idempotency_key: '2026-06-16 12:00',
    target_user_id: null,
    payload: { emitted_at: '2026-06-16 12:00:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'workers-test',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function fakeAdapter(name: string, candidates: CandidateInput[]): NewsIngestAdapter {
  return {
    name,
    defaultCategory: 'congress',
    fetch: vi.fn().mockResolvedValue(candidates),
  };
}

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    source_provider: 'congress',
    source_category: 'congress',
    source_title: 'Senate passes HR-1234 52-48',
    source_url: 'https://www.congress.gov/bill/118hr1234',
    source_host: 'congress.gov',
    source_published_at: '2026-06-16T15:00:00Z',
    summary: 'Senate vote on HR-1234.',
    dedup_url_canon: 'https://congress.gov/bill/118hr1234',
    ...overrides,
  };
}

function freshState(): FakeState {
  return {
    inserted: [],
    insertedRejected: [],
    payloadUpdates: [],
    insertError: null,
    healthUpserts: new Map(),
    healthPriors: new Map(),
    healthBulkRows: [],
  };
}

// ---------------------------------------------------------------------------
// GDELT trending adapter — fixture-based tests
// ---------------------------------------------------------------------------

describe('humanizeUrlSlug — title derivation from URL path', () => {
  it('humanizes a dash-separated slug', () => {
    const t = humanizeUrlSlug(
      'https://www.whitehouse.gov/briefing-room/presidential-actions/executive-order-on-ai/',
      'whitehouse.gov',
      '123456789',
    );
    expect(t).toBe('Executive Order On Ai');
  });

  it('strips a leading <digits>. prefix', () => {
    const t = humanizeUrlSlug(
      'https://www.congress.gov/bill/118hr1234-senate-passes-tax-reform',
      'congress.gov',
      '123456789',
    );
    expect(t.toLowerCase()).toContain('senate');
    expect(t.toLowerCase()).toContain('tax');
  });

  it('strips a trailing .html / .pdf extension', () => {
    expect(
      humanizeUrlSlug('https://fbi.gov/news/press-releases/announcement.html', 'fbi.gov', '1'),
    ).toBe('Announcement');
    expect(
      humanizeUrlSlug(
        'https://supremecourt.gov/opinions/23pdf/22-1234.pdf',
        'supremecourt.gov',
        '1',
      ),
    ).toBe('22 1234');
  });

  it('falls back to host+event when the slug is unreadable', () => {
    expect(humanizeUrlSlug('https://congress.gov/', 'congress.gov', 'abc123xyz')).toBe(
      'congress.gov event abc123xyz',
    );
    expect(humanizeUrlSlug('not a url', 'bls.gov', 'id9999999999999')).toBe(
      'bls.gov event id99999999',
    );
  });

  it('caps overlong slugs at INGEST_MAX_TITLE_CHARS', () => {
    const long = 'x-'.repeat(1500); // 3000 chars
    const url = `https://congress.gov/bill/${long}`;
    const t = humanizeUrlSlug(url, 'congress.gov', '1');
    expect(t.length).toBeLessThanOrEqual(2000);
  });
});

describe('extractMentionsUrl — pointer-file 2nd-line parser', () => {
  it('extracts the mentions URL from a 3-line lastupdate.txt and rewrites to https', () => {
    const body =
      '87478 abc http://data.gdeltproject.org/gdeltv2/20261013170000.export.CSV.zip\n' +
      '131731 def http://data.gdeltproject.org/gdeltv2/20261013170000.mentions.CSV.zip\n' +
      '6571620 ghi http://data.gdeltproject.org/gdeltv2/20261013170000.gkg.csv.zip';
    const url = extractMentionsUrl(body);
    expect(url).toBe('https://data.gdeltproject.org/gdeltv2/20261013170000.mentions.CSV.zip');
  });

  it('tolerates CRLF line endings', () => {
    const body =
      '87478 abc http://data.gdeltproject.org/gdeltv2/20261013170000.export.CSV.zip\r\n' +
      '131731 def http://data.gdeltproject.org/gdeltv2/20261013170000.mentions.CSV.zip\r\n';
    expect(extractMentionsUrl(body)).toContain('mentions.CSV.zip');
  });

  it('rejects a mentions URL on a non-GDELT host (SSRF defense)', () => {
    const body =
      '87478 abc http://data.gdeltproject.org/gdeltv2/20261013170000.export.CSV.zip\n' +
      '131731 def http://evil.example.com/gdeltv2/20261013170000.mentions.CSV.zip\n';
    expect(extractMentionsUrl(body)).toBeNull();
  });

  it('rejects a mentions URL whose path does not match the canonical shape', () => {
    const body =
      '87478 abc http://data.gdeltproject.org/gdeltv2/20261013170000.export.CSV.zip\n' +
      '131731 def http://data.gdeltproject.org/elsewhere/20261013170000.mentions.CSV.zip\n';
    expect(extractMentionsUrl(body)).toBeNull();
  });

  it('returns null on a <2-line pointer', () => {
    expect(extractMentionsUrl('')).toBeNull();
    expect(extractMentionsUrl('one line only')).toBeNull();
  });

  it('returns null when the 2nd line has <3 whitespace-separated fields', () => {
    expect(extractMentionsUrl('a b c\nd e')).toBeNull();
  });
});

describe('parseGdeltMentionsCsv — TSV row parser', () => {
  it('parses a single well-formed row (6+ cols)', () => {
    const row = [
      '1327702546', // 0 GLOBALEVENTID
      '20261013123000', // 1 EventTimeDate
      '20261013170000', // 2 MentionTimeDate
      '1', // 3 MentionType
      'congress.gov', // 4 MentionSourceName
      'https://www.congress.gov/bill/118hr1234', // 5 MentionIdentifier
      '4',
      '395',
      '482',
    ].join('\t');
    const out = parseGdeltMentionsCsv(row);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      globalEventId: '1327702546',
      eventTimeDate: '20261013123000',
      sourceName: 'congress.gov',
      url: 'https://www.congress.gov/bill/118hr1234',
    });
  });

  it('drops rows with <6 columns', () => {
    expect(parseGdeltMentionsCsv('1\t2\t3\t4\t5')).toEqual([]);
  });

  it('drops rows with an empty required column', () => {
    const row = ['1', '20260101000000', '20260101000000', '1', '', 'https://x.gov/a'].join('\t');
    expect(parseGdeltMentionsCsv(row)).toEqual([]);
  });

  it('tolerates CRLF + skips blank lines', () => {
    const r = (dom: string, url: string): string =>
      ['1', '20260101000000', '20260101000000', '1', dom, url].join('\t');
    const csv = r('a.gov', 'https://a.gov/1') + '\r\n\r\n' + r('b.gov', 'https://b.gov/2');
    expect(parseGdeltMentionsCsv(csv)).toHaveLength(2);
  });

  // Round-2 reviewer LOW 2 — parse-time length bound on url/host.
  it('drops rows whose URL exceeds INGEST_MAX_URL_CHARS at parse time', () => {
    const longUrl = 'https://a.gov/' + 'x'.repeat(2048);
    const row = ['1', '20260101000000', '20260101000000', '1', 'a.gov', longUrl].join('\t');
    expect(parseGdeltMentionsCsv(row)).toEqual([]);
  });

  it('drops rows whose sourceName exceeds 253 chars at parse time', () => {
    const longHost = 'x'.repeat(254) + '.gov';
    const row = ['1', '20260101000000', '20260101000000', '1', longHost, 'https://a.gov/x'].join(
      '\t',
    );
    expect(parseGdeltMentionsCsv(row)).toEqual([]);
  });

  // Round-2 reviewer LOW 1 — cap counts accepted rows (not line index),
  // so a padded CSV cannot push effective parse depth to zero.
  it('row cap counts ACCEPTED rows, not line index (padding-resistant)', () => {
    // 100 blank lines, then 3 valid rows. All 3 must be returned.
    const valid = (eid: string): string =>
      ['e-' + eid, '20260101000000', '20260101000000', '1', 'a.gov', `https://a.gov/${eid}`].join(
        '\t',
      );
    const csv = '\n'.repeat(100) + [valid('1'), valid('2'), valid('3')].join('\n');
    expect(parseGdeltMentionsCsv(csv)).toHaveLength(3);
  });
});

describe('clusterGdeltMentions — operator trend-score + primary-source rules', () => {
  // Build a Mentions-shaped row. GDELT 2.0 Mentions columns:
  //   0: GLOBALEVENTID, 1: EventTimeDate, 4: MentionSourceName, 5: MentionIdentifier.
  function m(overrides: { eventId?: string; time?: string; domain?: string; url?: string }): {
    globalEventId: string;
    eventTimeDate: string;
    sourceName: string;
    url: string;
  } {
    return {
      globalEventId: overrides.eventId ?? '1000',
      eventTimeDate: overrides.time ?? '20261013120000',
      sourceName: overrides.domain ?? 'congress.gov',
      url: overrides.url ?? 'https://www.congress.gov/bill/118hr1234',
    };
  }

  it('drops an event whose only outlet is a non-primary host', async () => {
    const out = await clusterGdeltMentions([
      m({ domain: 'example.com', url: 'https://news.example.com/x' }),
    ]);
    expect(out).toEqual([]);
  });

  it('drops an event that only reaches 1 outlet (below GDELT_MIN_TREND_SCORE)', async () => {
    expect(GDELT_MIN_TREND_SCORE).toBe(2);
    expect(await clusterGdeltMentions([m({ domain: 'congress.gov' })])).toEqual([]);
  });

  it('emits a candidate for an event with ≥2 outlets AND a primary host', async () => {
    const out = await clusterGdeltMentions([
      m({ eventId: '42', domain: 'example.com', url: 'https://news.example.com/sen-bill' }),
      m({ eventId: '42', domain: 'example.net', url: 'https://other.example.net/sen-bill' }),
      m({ eventId: '42', domain: 'congress.gov', url: 'https://www.congress.gov/bill/118hr1234' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.source_url).toBe('https://www.congress.gov/bill/118hr1234');
    expect(out[0]?.source_provider).toBe('gdelt');
    expect(out[0]?.source_category).toBe('congress');
    expect(out[0]?.evidence_tier).toBe('primary');
    expect(out[0]?.summary).toMatch(/^\[trend=3]/);
  });

  it('rejects an event of ≥2 outlets with NO allowed URLs (no primary, no reputable)', async () => {
    const out = await clusterGdeltMentions([
      m({ eventId: '7', domain: 'example.com', url: 'https://news.example.com/x' }),
      m({ eventId: '7', domain: 'example.net', url: 'https://other.example.net/x' }),
    ]);
    expect(out).toEqual([]);
  });

  // S1+S3 extension — events with no primary doc fall back to reputable.
  it('emits a reputable-tier candidate when no primary URL exists but a reputable outlet does', async () => {
    const out = await clusterGdeltMentions([
      m({ eventId: '77', domain: 'example.com', url: 'https://news.example.com/x' }),
      m({ eventId: '77', domain: 'reuters.com', url: 'https://www.reuters.com/world/story' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence_tier).toBe('reputable');
    expect(out[0]?.outlet_lean).toBe('center');
    expect(out[0]?.outlet_group).toBe('center');
    expect(out[0]?.outlet_type).toBe('news');
    expect(out[0]?.global_event_id).toBe('77');
    expect(out[0]?.source_url).toBe('https://www.reuters.com/world/story');
  });

  // S1+S3 — primary wins over reputable even when both present in a cluster.
  it('prefers primary URL over reputable when both are present in the cluster', async () => {
    const out = await clusterGdeltMentions([
      m({ eventId: '88', domain: 'reuters.com', url: 'https://www.reuters.com/story' }),
      m({ eventId: '88', domain: 'congress.gov', url: 'https://www.congress.gov/bill/118hr99' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence_tier).toBe('primary');
    expect(out[0]?.source_url).toContain('congress.gov');
  });

  it('sorts output by trend score desc (big viral first — operator rule)', async () => {
    const rows = [
      // Event A: 2 outlets, 1 primary (sec.gov).
      m({
        eventId: '1',
        domain: 'sec.gov',
        time: '20261013050000',
        url: 'https://www.sec.gov/litigation/litreleases/2026/lr-small',
      }),
      m({ eventId: '1', domain: 'example.com', url: 'https://news.example.com/sec-abc' }),
      // Event B: 4 outlets, 1 primary (congress.gov).
      m({ eventId: '2', domain: 'news-1.example.com', url: 'https://news-1.example.com/sen' }),
      m({ eventId: '2', domain: 'news-2.example.com', url: 'https://news-2.example.com/sen' }),
      m({ eventId: '2', domain: 'news-3.example.com', url: 'https://news-3.example.com/sen' }),
      m({ eventId: '2', domain: 'congress.gov', url: 'https://www.congress.gov/bill/118hr1234' }),
    ];
    const out = await clusterGdeltMentions(rows);
    expect(out).toHaveLength(2);
    expect(out[0]?.source_url).toContain('congress.gov');
    expect(out[1]?.source_url).toContain('sec.gov');
    expect(out[0]?.summary).toMatch(/^\[trend=4]/);
    expect(out[1]?.summary).toMatch(/^\[trend=2]/);
  });

  it('parses GDELT eventTimeDate (yyyyMMddHHmmss) to ISO 8601', async () => {
    const out = await clusterGdeltMentions([
      m({
        eventId: 'A',
        time: '20261013053000',
        domain: 'a.example.com',
        url: 'https://a.example.com/x',
      }),
      m({
        eventId: 'A',
        time: '20261013053100',
        domain: 'b.example.com',
        url: 'https://b.example.com/x',
      }),
      m({
        eventId: 'A',
        time: '20261013053200',
        domain: 'congress.gov',
        url: 'https://www.congress.gov/bill/1',
      }),
    ]);
    expect(out[0]?.source_published_at).toBe('2026-10-13T05:32:00Z');
  });

  it('returns [] for an empty mentions array', async () => {
    expect(await clusterGdeltMentions([])).toEqual([]);
  });

  // Round-2 reviewer MED 8 — GDELT sink applies requireHttpsUrl
  // symmetrically with the candidate-picking path. A non-https URL
  // that somehow slipped past classifyUrl must not reach the sink.
  it('gdeltMentionSink rejects a non-https URL before invoking the sink (round-2 MED 8)', async () => {
    const sinkCalls: unknown[] = [];
    const sinks = {
      gdeltMentionSink: async (payload: unknown) => {
        sinkCalls.push(payload);
      },
    };
    // Craft a mention whose classifyUrl would have thrown — but if a
    // future classifyUrl loosening ever lets http:// through, the
    // sink path's requireHttpsUrl re-check keeps the storage boundary
    // closed. We can't directly test "classifyUrl loosened" from here;
    // instead we assert that a known-invalid URL (file:) never reaches
    // the sink even if classifyUrl ever misclassified it. The current
    // classifyUrl correctly rejects file:, so the sink is never called
    // for that URL today — which is the test contract.
    await clusterGdeltMentions(
      [
        m({ eventId: 'X', domain: 'congress.gov', url: 'file:///etc/passwd' }),
        m({ eventId: 'X', domain: 'congress.gov', url: 'https://www.congress.gov/ok' }),
      ],
      sinks,
    );
    // Only the valid https URL should reach the sink.
    expect(sinkCalls).toHaveLength(1);
    expect((sinkCalls[0] as { url: string }).url).toBe('https://www.congress.gov/ok');
  });

  // S1+S3 — the sink fires per allowed mention (primary + reputable).
  it('invokes gdeltMentionSink for every allowed mention (not disallowed)', async () => {
    const sinkCalls: unknown[] = [];
    const sinks = {
      gdeltMentionSink: async (m: unknown) => {
        sinkCalls.push(m);
      },
    };
    await clusterGdeltMentions(
      [
        m({ eventId: 'S', domain: 'reuters.com', url: 'https://www.reuters.com/world/x' }),
        m({ eventId: 'S', domain: 'congress.gov', url: 'https://www.congress.gov/bill/1' }),
        m({ eventId: 'S', domain: 'random.co', url: 'https://news.random.co/x' }), // not allowed
      ],
      sinks,
    );
    expect(sinkCalls).toHaveLength(2);
    const hosts = sinkCalls.map((c) => (c as { host: string }).host);
    expect(hosts).toContain('reuters.com');
    expect(hosts).toContain('congress.gov');
    expect(hosts).not.toContain('random.co');
    // AP/Reuters are PAYWALL_FREE_PREFERRED; congress.gov is not.
    const reuters = sinkCalls.find((c) => (c as { host: string }).host === 'reuters.com') as {
      isPaywallFreePreferred: boolean;
      evidenceTier: string;
    };
    expect(reuters.isPaywallFreePreferred).toBe(true);
    expect(reuters.evidenceTier).toBe('reputable');
    const congress = sinkCalls.find((c) => (c as { host: string }).host === 'congress.gov') as {
      isPaywallFreePreferred: boolean;
      evidenceTier: string;
    };
    expect(congress.isPaywallFreePreferred).toBe(false);
    expect(congress.evidenceTier).toBe('primary');
  });

  // Security-reviewer PR #201 round 3 MED 7.2 — explicit scheme assert.
  describe('requireHttpsUrl (scheme-assert helper)', () => {
    const { requireHttpsUrl } = __testing;

    it.each([
      ['http://congress.gov/x', 'http'],
      ['javascript:alert(1)', 'javascript'],
      ['data:text/html,<script>', 'data'],
      ['file:///etc/passwd', 'file'],
      ['ftp://congress.gov/x', 'ftp'],
      ['//congress.gov/x', 'protocol-relative'],
    ])('returns null for %s (%s)', (input, _label) => {
      expect(requireHttpsUrl(input)).toBeNull();
    });

    it('returns the parsed URL for a well-formed https URL', () => {
      const u = requireHttpsUrl('https://www.congress.gov/bill/118hr1234');
      expect(u).not.toBeNull();
      expect(u?.protocol).toBe('https:');
      expect(u?.hostname).toBe('www.congress.gov');
    });

    it('returns null for a malformed URL that new URL() rejects', () => {
      expect(requireHttpsUrl('not-a-url')).toBeNull();
      expect(requireHttpsUrl('')).toBeNull();
    });

    // #215 LOW: reject URLs that carry credentials in the authority.
    // Partners with the DB-side `@`-exclusion in migration
    // 20261018000000's regex — this guard is the earliest storage
    // boundary and keeps the credential-carrying URL from ever
    // reaching the sink / RPC call.
    it('rejects URLs that carry credentials in the authority (#215)', () => {
      // `new URL('https://a@b/').hostname` is 'b' and would route
      // the fetch to attacker-controlled territory while any name-
      // based filter examined the raw prefix.
      expect(requireHttpsUrl('https://attacker.com@internal.svc/path')).toBeNull();
      expect(requireHttpsUrl('https://user:pass@example.com/x')).toBeNull();
      expect(requireHttpsUrl('https://user@example.com/')).toBeNull();
    });
  });

  describe('length caps on source_url (PR #205 LOW 2.4)', () => {
    it('drops an event whose primary.url exceeds 2048 chars', async () => {
      const longPath = 'x'.repeat(2100);
      const out = await clusterGdeltMentions([
        m({
          eventId: '9',
          domain: 'congress.gov',
          url: `https://www.congress.gov/bill/${longPath}`,
        }),
        m({ eventId: '9', domain: 'b.congress.gov', url: 'https://b.congress.gov/x' }),
      ]);
      expect(out).toEqual([]);
    });

    it('accepts a URL at the exact 2048-char boundary', async () => {
      const basePath = 'https://www.congress.gov/bill/';
      const url = basePath + 'x'.repeat(2048 - basePath.length);
      expect(url.length).toBe(2048);
      const out = await clusterGdeltMentions([
        m({ eventId: '10', domain: 'congress.gov', url }),
        m({ eventId: '10', domain: 'b.congress.gov', url: 'https://b.congress.gov/x' }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]?.source_url.length).toBe(2048);
    });

    // #207 round-1 reviewer LOW 3 — RSS path shares the same caps.
    it('normalizeRssItem truncates title + rejects oversized URL (parity with GDELT)', () => {
      const { normalizeRssItem, INGEST_MAX_TITLE_CHARS, INGEST_MAX_URL_CHARS } = __testing;

      const ok = normalizeRssItem({
        provider: 'test',
        defaultCategory: 'congress',
        item: {
          title: 'ok title',
          link: 'https://www.congress.gov/' + 'x'.repeat(INGEST_MAX_URL_CHARS + 10),
          isoDate: null,
          contentSnippet: null,
        },
      });
      expect(ok).toBeNull();

      const trunc = normalizeRssItem({
        provider: 'test',
        defaultCategory: 'congress',
        item: {
          title: 'A'.repeat(INGEST_MAX_TITLE_CHARS + 100),
          link: 'https://www.congress.gov/x',
          isoDate: null,
          contentSnippet: null,
        },
      });
      expect(trunc).not.toBeNull();
      expect(trunc!.source_title.length).toBe(INGEST_MAX_TITLE_CHARS);
    });
  });

  // Security-reviewer PR #201 round 2 — stamp dedicated numeric column.
  it('writes trend_score on each emitted candidate (not only in the summary prefix)', async () => {
    const out = await clusterGdeltMentions([
      m({ eventId: 'T', domain: 'example.com', url: 'https://news.example.com/sen' }),
      m({ eventId: 'T', domain: 'example.net', url: 'https://news.example.net/sen' }),
      m({ eventId: 'T', domain: 'congress.gov', url: 'https://www.congress.gov/bill/118hr1234' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.trend_score).toBe(3);
    expect(out[0]?.summary).toMatch(/^\[trend=3]/);
  });
});

describe('gdeltAdapter — Option B (data.gdeltproject.org raw export files)', () => {
  const ENV_ON = envWith({ GDELT_ENABLED: true });
  const ENV_OFF = envWith({ GDELT_ENABLED: false });

  const POINTER_TS = '20261013170000';
  const MENTIONS_URL_HTTPS = `https://data.gdeltproject.org/gdeltv2/${POINTER_TS}.mentions.CSV.zip`;
  const POINTER_BODY =
    `87478 abc http://data.gdeltproject.org/gdeltv2/${POINTER_TS}.export.CSV.zip\n` +
    `131731 def http://data.gdeltproject.org/gdeltv2/${POINTER_TS}.mentions.CSV.zip\n` +
    `6571620 ghi http://data.gdeltproject.org/gdeltv2/${POINTER_TS}.gkg.csv.zip`;

  /** Build a Mentions-CSV TSV body with two rows per event id (so trend
   *  score ≥ 2) and one primary-source domain among them. */
  function buildCsv(rows: Array<[string, string, string, string]>): string {
    // columns: 0 eventId, 1 time, 2 time, 3 type, 4 domain, 5 url
    return rows
      .map(([eventId, time, dom, url]) =>
        [eventId, time, time, '1', dom, url, '4', '395', '482'].join('\t'),
      )
      .join('\n');
  }

  function zipCsv(csv: string): Uint8Array {
    return zipSync({ [`${POINTER_TS}.mentions.CSV`]: strToU8(csv) });
  }

  const HAPPY_CSV = buildCsv([
    ['1', '20261013170000', 'example.com', 'https://news.example.com/sen'],
    ['1', '20261013170000', 'congress.gov', 'https://www.congress.gov/bill/118hr1234'],
  ]);

  /** fetchImpl that returns the pointer for /lastupdate.txt and the zip
   *  for the mentions URL. */
  function happyFetch(csv: string = HAPPY_CSV): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/lastupdate.txt')) {
        return new Response(POINTER_BODY, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (url === MENTIONS_URL_HTTPS) {
        const bytes = zipCsv(csv);
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  // Reset the module-local rate-limit cursor before every test (PR #205).
  beforeEach(() => {
    __testing.resetGdeltRateLimitState();
  });

  it('returns [] when env.GDELT_ENABLED is false (never hits the network)', async () => {
    const fetchImpl = vi.fn(async () => new Response('should not be called'));
    const out = await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_OFF);
    expect(out).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches + unzips + parses + clusters when env.GDELT_ENABLED is true', async () => {
    const fetchImpl = happyFetch();
    const out = await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/lastupdate.txt');
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(MENTIONS_URL_HTTPS);
    expect(out).toHaveLength(1);
    expect(out[0]?.source_url).toBe('https://www.congress.gov/bill/118hr1234');
    expect(out[0]?.source_provider).toBe('gdelt');
    expect(out[0]?.trend_score).toBe(2);
  });

  it('rejects a redirect on the pointer file (3xx is a hard fail)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example.com/pwn' },
        }),
    );
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/refusing to follow redirect/);
  });

  it('rejects a non-200 pointer response', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 503 }));
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('rejects a pointer whose mentions URL points to a non-GDELT host', async () => {
    const BAD = POINTER_BODY.replaceAll('data.gdeltproject.org', 'evil.example.com');
    const fetchImpl = vi.fn(
      async () =>
        new Response(BAD, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/lastupdate.txt did not yield/);
  });

  it('rejects a single-entry zip whose entry is not a .CSV', async () => {
    const otherZip = zipSync({ 'readme.txt': strToU8('nothing to see') });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/lastupdate.txt')) {
        return new Response(POINTER_BODY, { status: 200 });
      }
      return new Response(otherZip, { status: 200 });
    });
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/zip entry is not a .CSV/);
  });

  // Round-2 reviewer MED 3 — reject multi-entry archives at the EOCD
  // pre-flight stage, before any `unzipSync` allocation. GDELT's
  // documented format is exactly one entry per zip.
  it('rejects a multi-entry zip at EOCD pre-flight (no decompression attempted)', async () => {
    const multiZip = zipSync({
      [`${POINTER_TS}.mentions.CSV`]: strToU8('a\tb\tc\td\te\tf'),
      'extra.CSV': strToU8('x\ty\tz\td\te\tf'),
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/lastupdate.txt')) {
        return new Response(POINTER_BODY, { status: 200 });
      }
      return new Response(multiZip, { status: 200 });
    });
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/expected single-entry zip, got 2/);
  });

  // Round-2 reviewer MED 4 — zip entry filenames are sanitized before
  // reaching any error message or log field. A crafted name with path
  // separators / newlines / ANSI escapes must not leak into the error.
  it('sanitizes zip-entry filenames in error strings (MED 4)', async () => {
    const nastyZip = zipSync({ '../../etc/passwd.txt\n\x1b[31mred': strToU8('x') });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/lastupdate.txt')) {
        return new Response(POINTER_BODY, { status: 200 });
      }
      return new Response(nastyZip, { status: 200 });
    });
    const err = await gdeltAdapter
      .fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // Must not contain path separators, newlines, or escape sequences.
    expect(msg).not.toContain('/');
    expect(msg).not.toContain('\n');
    expect(msg).not.toMatch(/\x1b/);
    // Sanitizer replaces disallowed chars with `_` and caps at 64 chars.
    expect(msg).toContain('name=');
  });

  it('rate-limits back-to-back fetches within GDELT_MIN_FETCH_INTERVAL_MS', async () => {
    const fetchImpl = happyFetch();
    await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const out2 = await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON);
    expect(out2).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // still only the first run's 2 calls
  });

  it('rate-limit cursor allows fetch after reset (test seam exercise)', async () => {
    const fetchImpl = happyFetch();
    await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    __testing.resetGdeltRateLimitState();
    await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  // Security-reviewer PR #201 round 3 MED 3.1 — adapter MUST NOT read
  // process.env; env.GDELT_ENABLED threaded through fetch() is the
  // single source of truth.
  it('does NOT read process.env; mutating process.env.GDELT_ENABLED has no effect', async () => {
    const prev = process.env.GDELT_ENABLED;
    process.env.GDELT_ENABLED = 'true';
    try {
      const fetchImpl = vi.fn(async () => new Response('should not be called'));
      const out = await gdeltAdapter.fetch(
        fetchImpl as unknown as typeof globalThis.fetch,
        ENV_OFF,
      );
      expect(out).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.GDELT_ENABLED;
      else process.env.GDELT_ENABLED = prev;
    }
  });

  it('does NOT read process.env; empty raw env still fetches when passed env says enabled', async () => {
    const prev = process.env.GDELT_ENABLED;
    delete process.env.GDELT_ENABLED;
    try {
      const fetchImpl = happyFetch();
      await gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      if (prev !== undefined) process.env.GDELT_ENABLED = prev;
    }
  });

  // Security-reviewer PR #201 round 2 — streaming body size cap on the
  // compressed-zip fetch.
  it('aborts a mentions.zip response that streams past the compressed size cap', async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MB zero-filled
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (pulls >= 3) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        pulls += 1;
      },
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/lastupdate.txt')) {
        return new Response(POINTER_BODY, { status: 200 });
      }
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    });
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/exceeds .* cap/);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  // Zip-bomb defense: compressed input is capped at 2 MiB upstream; this
  // asserts the decompressed-CSV cap also fires. We fabricate a zip
  // whose uncompressed payload exceeds the 20 MiB cap by repeating a
  // highly-compressible value.
  it('rejects a decompressed CSV that exceeds the 20 MiB cap', async () => {
    // 25 MB of a single highly-compressible char — zip compresses to
    // tens of KB, well under the 2 MiB compressed cap.
    const bigCsv = 'a'.repeat(25 * 1024 * 1024);
    const bigZip = zipSync({ [`${POINTER_TS}.mentions.CSV`]: strToU8(bigCsv) });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/lastupdate.txt')) {
        return new Response(POINTER_BODY, { status: 200 });
      }
      return new Response(bigZip, { status: 200 });
    });
    await expect(
      gdeltAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch, ENV_ON),
    ).rejects.toThrow(/decompressed CSV .* exceeds .* cap/);
  });
});

describe('newsIngestHandler — happy path', () => {
  it('iterates all adapters and inserts allowed candidates', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [
      fakeAdapter('congress', [candidate()]),
      fakeAdapter('bls', [
        candidate({
          source_provider: 'bls',
          source_category: 'bls_labor',
          source_url: 'https://www.bls.gov/news.release/empsit.htm',
          source_host: 'bls.gov',
          dedup_url_canon: 'https://bls.gov/news.release/empsit.htm',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(2);
    expect(state.inserted[0]!.source_provider).toBe('congress');
    expect(state.inserted[1]!.source_provider).toBe('bls');
    expect(state.payloadUpdates).toHaveLength(1);
    const summary = state.payloadUpdates[0]!.patch.payload as {
      ingest_total_inserted: number;
    };
    expect(summary.ingest_total_inserted).toBe(2);
  });

  it('rejects non-allow-list URLs (host_not_allowed)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [
      fakeAdapter('congress', [
        candidate(), // allowed
        candidate({
          source_url: 'https://example.com/bogus',
          source_host: 'example.com',
          dedup_url_canon: 'https://example.com/bogus',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(1); // allowed only
    expect(state.insertedRejected).toHaveLength(1);
    expect(state.insertedRejected[0]!.rejected_reason).toBe('host_not_allowed');
  });

  it('classifies ban-list URLs as host_not_allowed (never primary)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    // A primary-source feed should never return a ban-list URL — this
    // test is defense in depth. Uses foxnews.com (still MSM-banned
    // after S1+S3 — operator didn't approve it for the reputable
    // allowlist; MBFC rates it 'Mixed').
    const adapters = [
      fakeAdapter('congress', [
        candidate({
          source_url: 'https://www.foxnews.com/politics/article/1',
          source_host: 'foxnews.com',
          dedup_url_canon: 'https://foxnews.com/politics/article/1',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(0);
    expect(state.insertedRejected).toHaveLength(1);
    expect(state.insertedRejected[0]!.rejected_reason).toBe('host_not_allowed');
  });

  it('one adapter failure does not kill the whole tick', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const failingAdapter: NewsIngestAdapter = {
      name: 'broken',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(new Error('feed 503')),
    };
    const goodAdapter = fakeAdapter('bls', [
      candidate({
        source_provider: 'bls',
        source_category: 'bls_labor',
        source_url: 'https://www.bls.gov/news.release/empsit.htm',
        source_host: 'bls.gov',
        dedup_url_canon: 'https://bls.gov/news.release/empsit.htm',
      }),
    ]);
    const handler = buildNewsIngestHandler([failingAdapter, goodAdapter], STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    // Good adapter still inserted its candidate.
    expect(state.inserted).toHaveLength(1);
    // Failure logged.
    expect(logger.calls.find((c) => c.obj.event === 'news_ingest.adapter_failed')).toBeDefined();
  });

  // PR #211 — Telegram alert on adapter failure + cause-chain capture.
  it('fires a per-adapter Telegram alert on adapter failure (dedup-keyed)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const alertCalls: Array<{
      level: string;
      title: string;
      body: string;
      opts?: { dedupKey?: string; dedupTtlMs?: number };
    }> = [];
    const alerter = {
      alert: vi.fn(
        async (
          level: string,
          title: string,
          body: string,
          opts?: { dedupKey?: string; dedupTtlMs?: number },
        ) => {
          alertCalls.push({ level, title, body, opts });
        },
      ),
    };
    // Build an Error whose cause chain mirrors undici's wrap of
    // ECONNRESET. The alerter body should contain the inner `code`.
    const inner = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const outer = new TypeError('fetch failed', { cause: inner });
    const failingAdapter: NewsIngestAdapter = {
      name: 'gdelt',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(outer),
    };
    const handler = buildNewsIngestHandler([failingAdapter], STUB_ENV_PROVIDER);

    await handler(row(), {
      supabase,
      logger,
      alerter: alerter as never,
      fetch: vi.fn() as never,
    });

    expect(alertCalls).toHaveLength(1);
    const [call] = alertCalls;
    expect(call?.level).toBe('error');
    expect(call?.title).toBe('news_ingest adapter_failed:gdelt');
    expect(call?.body).toContain('adapter=gdelt');
    // The inner cause's code is surfaced — this is the whole point.
    expect(call?.body).toContain('ECONNRESET');
    expect(call?.opts?.dedupKey).toBe('news_ingest:adapter_failed:gdelt');
    expect(call?.opts?.dedupTtlMs).toBe(60 * 60_000);
  });

  it('no alert when deps.alerter is undefined (fire-and-forget)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const failingAdapter: NewsIngestAdapter = {
      name: 'broken',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(new Error('feed 503')),
    };
    const handler = buildNewsIngestHandler([failingAdapter], STUB_ENV_PROVIDER);
    // No alerter in deps.
    await handler(row(), { supabase, logger, fetch: vi.fn() as never });
    // Did not throw; adapter_failed was logged.
    expect(logger.calls.find((c) => c.obj.event === 'news_ingest.adapter_failed')).toBeDefined();
  });

  it('persists the full cause chain into news_adapter_health.last_error_message', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND api.gdeltproject.org'), {
      code: 'ENOTFOUND',
    });
    const outer = new TypeError('fetch failed', { cause: inner });
    const failingAdapter: NewsIngestAdapter = {
      name: 'gdelt',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(outer),
    };
    const handler = buildNewsIngestHandler([failingAdapter], STUB_ENV_PROVIDER);
    await handler(row(), { supabase, logger, fetch: vi.fn() as never });
    const healthRow = state.healthUpserts.get('gdelt');
    expect(healthRow).toBeDefined();
    // Full chain lands in last_error_message, not just the outer "fetch failed".
    expect(healthRow?.last_error_message as string).toContain('fetch failed');
    expect(healthRow?.last_error_message as string).toContain('ENOTFOUND');
  });

  it('caps last_error_message at 1024 chars before DB write (#211 reviewer LOW 3)', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    // 4000-char message; single-layer scrubbed chain blows past the cap.
    const huge = 'x'.repeat(4000);
    const failingAdapter: NewsIngestAdapter = {
      name: 'gdelt',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(new Error(huge)),
    };
    const handler = buildNewsIngestHandler([failingAdapter], STUB_ENV_PROVIDER);
    await handler(row(), { supabase, logger, fetch: vi.fn() as never });
    const healthRow = state.healthUpserts.get('gdelt');
    expect(healthRow).toBeDefined();
    expect((healthRow?.last_error_message as string).length).toBeLessThanOrEqual(1024);
  });

  it('caps error.code at 64 chars inside the chain message (#211 reviewer LOW 1)', () => {
    const { errorChainMessage } = __testing;
    const longCode = 'A'.repeat(500);
    const e = Object.assign(new Error('boom'), { code: longCode });
    const msg = errorChainMessage(e);
    // Bracketed suffix contains the truncated code only.
    expect(msg).toContain('[' + 'A'.repeat(64) + ']');
    expect(msg).not.toContain('A'.repeat(65));
  });

  // Round-1 reviewer MED 3 — the cross-tick cluster upsert must be
  // atomic. Previously two Supabase calls (upsert then update) raced;
  // now a single SECURITY DEFINER RPC does both with COALESCE on
  // primary_url + best_news_url.
  describe('upsertGdeltEventMention (round-1 MED 3 atomic RPC)', () => {
    const { upsertGdeltEventMention } = __testing;

    it('calls the upsert_gdelt_event_mention RPC with the mention payload', async () => {
      const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const supabase = {
        rpc(fn: string, args: Record<string, unknown>) {
          rpcCalls.push({ fn, args });
          return Promise.resolve({ error: null });
        },
      };
      const logger = buildLogger();
      await upsertGdeltEventMention(
        { supabase, logger, fetch: vi.fn() as never },
        {
          globalEventId: '1234',
          eventTimeDate: '20261013170000',
          url: 'https://apnews.com/story',
          host: 'apnews.com',
          evidenceTier: 'reputable',
          outletLean: 'center',
          outletGroup: 'center',
          outletType: 'news',
          isPaywallFreePreferred: true,
        },
      );
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0]).toMatchObject({
        fn: 'upsert_gdelt_event_mention',
        args: {
          p_global_event_id: '1234',
          p_url: 'https://apnews.com/story',
          p_host: 'apnews.com',
          p_evidence_tier: 'reputable',
          p_outlet_lean: 'center',
          p_outlet_group: 'center',
          p_outlet_type: 'news',
          p_is_paywall_free_preferred: true,
        },
      });
    });

    it('omits the outlet-triple when the mention is primary tier (no lean/group/type)', async () => {
      const rpcCalls: Array<{ args: Record<string, unknown> }> = [];
      const supabase = {
        rpc(_fn: string, args: Record<string, unknown>) {
          rpcCalls.push({ args });
          return Promise.resolve({ error: null });
        },
      };
      const logger = buildLogger();
      await upsertGdeltEventMention(
        { supabase, logger, fetch: vi.fn() as never },
        {
          globalEventId: '9',
          eventTimeDate: '20261013170000',
          url: 'https://www.congress.gov/bill/1',
          host: 'congress.gov',
          evidenceTier: 'primary',
          isPaywallFreePreferred: false,
        },
      );
      // After condition 3 fix (migration 20261017000000): outlet args
      // have `default null` in the SQL function and `p_outlet_*?: T`
      // in the generated types. The TS boundary now passes
      // `undefined` (not `null`) when the mention is primary-tier —
      // Postgres applies the SQL-level default, same end state.
      const args = rpcCalls[0]?.args as Record<string, unknown> | undefined;
      expect(args?.p_evidence_tier).toBe('primary');
      expect(args?.p_is_paywall_free_preferred).toBe(false);
      expect(args?.p_outlet_lean).toBeUndefined();
      expect(args?.p_outlet_group).toBeUndefined();
      expect(args?.p_outlet_type).toBeUndefined();
    });

    it('fire-and-forget: an RPC error is logged, not thrown', async () => {
      const supabase = {
        rpc() {
          return Promise.resolve({ error: { message: 'db down' } });
        },
      };
      const logger = buildLogger();
      await expect(
        upsertGdeltEventMention(
          { supabase, logger, fetch: vi.fn() as never },
          {
            globalEventId: '7',
            eventTimeDate: '20261013170000',
            url: 'https://apnews.com/x',
            host: 'apnews.com',
            evidenceTier: 'reputable',
            outletLean: 'center',
            outletGroup: 'center',
            outletType: 'news',
            isPaywallFreePreferred: true,
          },
        ),
      ).resolves.toBeUndefined();
      expect(
        logger.calls.find((c) => c.obj.event === 'news_ingest.gdelt_cluster_upsert_failed'),
      ).toBeDefined();
    });
  });

  describe('errorChainMessage (test seam)', () => {
    const { errorChainMessage } = __testing;

    it('surfaces undici-style TypeError(fetch failed, cause: SystemError)', () => {
      const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const outer = new TypeError('fetch failed', { cause: inner });
      const msg = errorChainMessage(outer);
      expect(msg).toContain('fetch failed');
      expect(msg).toContain('read ECONNRESET');
      expect(msg).toContain('ECONNRESET');
      expect(msg.split(' <- ').length).toBe(2);
    });

    it('handles a bare string error', () => {
      expect(errorChainMessage('something broke')).toBe('something broke');
    });

    it('caps the chain depth at 5 (defensive against pathological cycles)', () => {
      // Build a 10-deep chain. Only first 5 layers should appear.
      let cur: Error = new Error('leaf');
      for (let i = 0; i < 9; i += 1) {
        cur = new Error(`layer${i}`, { cause: cur });
      }
      const msg = errorChainMessage(cur);
      expect(msg.split(' <- ').length).toBe(5);
    });

    it('includes error.code when present as a bracketed suffix', () => {
      const e = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
      expect(errorChainMessage(e)).toContain('[UND_ERR_SOCKET]');
    });
  });

  it('handles 23505 (unique violation) silently — re-ingest is expected', async () => {
    const state = freshState();
    state.insertError = { code: '23505', message: 'duplicate key value' };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [fakeAdapter('congress', [candidate()])];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    // No throw; the 23505 was absorbed as expected idempotency.
    expect(state.inserted).toHaveLength(0); // mock treats all inserts as failing
    const summary = state.payloadUpdates[0]!.patch.payload as {
      ingest_total_inserted: number;
    };
    expect(summary.ingest_total_inserted).toBe(0);
  });

  it('rejects http:// URLs (TLS required) as host_not_allowed', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [
      fakeAdapter('congress', [
        candidate({
          source_url: 'http://congress.gov/bill/1',
          source_host: 'congress.gov',
          dedup_url_canon: 'http://congress.gov/bill/1',
        }),
      ]),
    ];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(state.inserted).toHaveLength(0);
    expect(state.insertedRejected).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// news_adapter_health UPSERT + 24h staleness warn (PR follow-up to #154)
// ---------------------------------------------------------------------------

describe('news_adapter_health — per-adapter liveness tracking', () => {
  it('upserts last_success_at and last_fresh_insert_at when a candidate lands', async () => {
    const state = freshState();
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [fakeAdapter('congress', [candidate()])];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const health = state.healthUpserts.get('congress');
    expect(health).toBeDefined();
    expect(health!.last_success_at).toBeTypeOf('string');
    expect(health!.last_fresh_insert_at).toBeTypeOf('string');
    expect(health!.last_fetched_count).toBe(1);
    expect(health!.last_fresh_count).toBe(1);
    expect(health!.last_error_at).toBeNull();
  });

  it('does NOT advance last_fresh_insert_at when every row 23505-collides', async () => {
    const state = freshState();
    state.insertError = { code: '23505', message: 'duplicate key value' };
    // Prior row: adapter succeeded and produced fresh rows 2 hours ago.
    // The current tick re-ingests the same items (dedup absorbs them)
    // so last_fresh_insert_at MUST hold still — exactly the condition
    // the 24h-dedup warn is designed to catch.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.healthPriors.set('congress', {
      last_success_at: twoHoursAgo,
      last_fresh_insert_at: twoHoursAgo,
      last_error_at: null,
      last_error_message: null,
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const adapters = [fakeAdapter('congress', [candidate()])];
    const handler = buildNewsIngestHandler(adapters, STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const health = state.healthUpserts.get('congress');
    expect(health).toBeDefined();
    // last_success_at advances (fetch itself succeeded) but
    // last_fresh_insert_at stays frozen at the two-hour-ago prior.
    expect(health!.last_success_at).not.toBe(twoHoursAgo);
    expect(health!.last_fresh_insert_at).toBe(twoHoursAgo);
    expect(health!.last_fresh_count).toBe(0);
  });

  it('stamps last_error_at + last_error_message on adapter.fetch failure; preserves last_success_at', async () => {
    const state = freshState();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.healthPriors.set('broken', {
      last_success_at: twoHoursAgo,
      last_fresh_insert_at: twoHoursAgo,
      last_error_at: null,
      last_error_message: null,
    });
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const broken: NewsIngestAdapter = {
      name: 'broken',
      defaultCategory: 'congress',
      fetch: vi.fn().mockRejectedValue(new Error('feed 503')),
    };
    const handler = buildNewsIngestHandler([broken], STUB_ENV_PROVIDER);

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const health = state.healthUpserts.get('broken');
    expect(health).toBeDefined();
    expect(health!.last_error_at).toBeTypeOf('string');
    expect(health!.last_error_message).toBe('feed 503');
    // A failing fetch MUST NOT clear last_success_at — it holds the
    // last-known-good signal while the current tick is in a bad state.
    expect(health!.last_success_at).toBe(twoHoursAgo);
    expect(health!.last_fresh_insert_at).toBe(twoHoursAgo);
    expect(health!.last_fetched_count).toBe(0);
  });

  it('emits adapter_stale warn when last_fresh_insert_at >= 24h old', async () => {
    const state = freshState();
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Bulk-read result for warnStaleAdapters: one adapter stale, one fresh.
    state.healthBulkRows = [
      {
        adapter: 'bls',
        last_success_at: new Date().toISOString(),
        last_fresh_insert_at: twentyFiveHoursAgo,
        updated_at: twentyFiveHoursAgo,
      },
      {
        adapter: 'congress',
        last_success_at: new Date().toISOString(),
        last_fresh_insert_at: halfHourAgo,
        updated_at: halfHourAgo,
      },
    ];
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildNewsIngestHandler(
      [fakeAdapter('congress', [candidate()])],
      STUB_ENV_PROVIDER,
    );

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const warns = logger.calls.filter((c) => c.obj.event === 'news_ingest.adapter_stale');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj.adapter).toBe('bls');
    expect(warns[0]!.level).toBe('warn');
  });

  it('does NOT warn when last_fresh_insert_at is null AND the row is <24h old (cold-start grace)', async () => {
    const state = freshState();
    state.healthBulkRows = [
      {
        adapter: 'brand_new',
        last_success_at: null,
        last_fresh_insert_at: null,
        // Row created 5 minutes ago — brand new adapter, hasn't had a
        // chance to produce anything yet. A warn here would false-fire
        // on every new adapter rollout.
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    ];
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildNewsIngestHandler(
      [fakeAdapter('brand_new', [candidate()])],
      STUB_ENV_PROVIDER,
    );

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    expect(logger.calls.find((c) => c.obj.event === 'news_ingest.adapter_stale')).toBeUndefined();
  });

  it('DOES warn when last_fresh_insert_at is null AND the row is >=24h old', async () => {
    const state = freshState();
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    state.healthBulkRows = [
      {
        adapter: 'never_fresh',
        last_success_at: twentyFiveHoursAgo,
        last_fresh_insert_at: null,
        updated_at: twentyFiveHoursAgo,
      },
    ];
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    const handler = buildNewsIngestHandler(
      [fakeAdapter('never_fresh', [candidate()])],
      STUB_ENV_PROVIDER,
    );

    await handler(row(), { supabase, logger, fetch: vi.fn() as never });

    const warns = logger.calls.filter((c) => c.obj.event === 'news_ingest.adapter_stale');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj.adapter).toBe('never_fresh');
  });
});
