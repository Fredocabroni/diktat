import { describe, expect, it, vi } from 'vitest';

import {
  extractDescription,
  extractTitle,
  fetchFirstReadable,
  fetchOgText,
  pickTextSources,
} from '../../src/jobs/drop-source-text-fetch.js';

describe('pickTextSources — operator priority order', () => {
  it('puts PAYWALL_FREE_PREFERRED news hosts first, in order', () => {
    const outlets = [
      {
        url: 'https://www.motherjones.com/x',
        host: 'motherjones.com',
        outlet_type: 'commentary' as const,
      },
      { url: 'https://www.reuters.com/world', host: 'reuters.com', outlet_type: 'news' as const },
      { url: 'https://apnews.com/story', host: 'apnews.com', outlet_type: 'news' as const },
      { url: 'https://www.nytimes.com/story', host: 'nytimes.com', outlet_type: 'news' as const },
    ];
    const picked = pickTextSources(outlets, null, null);
    expect(picked.map((p) => p.host)).toEqual(['apnews.com', 'reuters.com', 'nytimes.com']);
  });

  it('excludes commentary outlets (never carries evidence text)', () => {
    const outlets = [
      {
        url: 'https://nationalreview.com/x',
        host: 'nationalreview.com',
        outlet_type: 'commentary' as const,
      },
      { url: 'https://thenation.com/x', host: 'thenation.com', outlet_type: 'commentary' as const },
    ];
    expect(pickTextSources(outlets, null, null)).toEqual([]);
  });

  it('uses bestNewsUrl hint only when host is in the preferred list', () => {
    const outlets = [
      { url: 'https://www.nytimes.com/x', host: 'nytimes.com', outlet_type: 'news' as const },
    ];
    // bestNewsHost = reuters.com (preferred) → surfaces first even if
    // not already in the outlets list.
    const withHint = pickTextSources(outlets, 'https://reuters.com/story', 'reuters.com');
    expect(withHint[0]?.host).toBe('reuters.com');
    // bestNewsHost = nytimes.com (NOT preferred) → ignored as a hint.
    const noHint = pickTextSources(outlets, 'https://nytimes.com/story', 'nytimes.com');
    expect(noHint[0]?.host).toBe('nytimes.com');
    expect(noHint).toHaveLength(1);
  });

  it('dedups the url+host pair across the hint + outlet list', () => {
    const outlets = [
      { url: 'https://apnews.com/story', host: 'apnews.com', outlet_type: 'news' as const },
    ];
    const picked = pickTextSources(outlets, 'https://apnews.com/story', 'apnews.com');
    expect(picked).toHaveLength(1);
  });
});

describe('extractTitle / extractDescription — meta-tag parser', () => {
  it('prefers og:title', () => {
    const html = `<html><head><meta property="og:title" content="The real one"><title>Fallback</title></head>`;
    expect(extractTitle(html)).toBe('The real one');
  });

  it('falls back to <title> when og:title missing', () => {
    const html = `<html><head><title>Just the title</title></head>`;
    expect(extractTitle(html)).toBe('Just the title');
  });

  it('prefers og:description', () => {
    const html = `<meta property="og:description" content="OG desc"><meta name="description" content="meta desc">`;
    expect(extractDescription(html)).toBe('OG desc');
  });

  it('falls back to meta name=description', () => {
    const html = `<meta name="description" content="meta desc">`;
    expect(extractDescription(html)).toBe('meta desc');
  });

  it('decodes common HTML entities', () => {
    const html = `<title>Alice &amp; Bob&#39;s &quot;plan&quot;</title>`;
    expect(extractTitle(html)).toBe(`Alice & Bob's "plan"`);
  });

  it('returns null when no title present', () => {
    expect(extractTitle('<html></html>')).toBeNull();
  });
});

describe('fetchOgText — SSRF-safe single-URL fetch', () => {
  it('refuses a host not on the news-outlets allowlist', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOgText(fetchImpl as never, 'https://example.org/story');
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-https URL', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOgText(fetchImpl as never, 'http://www.reuters.com/story');
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a commentary-type outlet (never evidence)', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOgText(fetchImpl as never, 'https://nationalreview.com/story');
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns parsed title/description for a reputable news host', async () => {
    const html = `<html><head>
      <meta property="og:title" content="Senate passes bill">
      <meta property="og:description" content="52-48 vote">
    </head></html>`;
    const fetchImpl = vi.fn(
      async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const result = await fetchOgText(fetchImpl as never, 'https://www.reuters.com/world/story');
    expect(result).toMatchObject({
      host: 'reuters.com',
      title: 'Senate passes bill',
      description: '52-48 vote',
    });
  });

  it('follows one redirect to another allowlisted host; refuses redirect to unlisted host', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://www.reuters.com/a') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://apnews.com/b' },
        });
      }
      if (url === 'https://apnews.com/b') {
        return new Response(`<title>Final page</title>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      throw new Error('unexpected ' + url);
    });
    const result = await fetchOgText(fetchImpl as never, 'https://www.reuters.com/a');
    expect(result?.title).toBe('Final page');
    expect(result?.host).toBe('apnews.com');
  });

  it('refuses a redirect to a non-allowlisted host', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example.com/pwn' },
        }),
    );
    const result = await fetchOgText(fetchImpl as never, 'https://www.reuters.com/story');
    expect(result).toBeNull();
  });

  it('returns null on non-2xx final response', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 503 }));
    expect(await fetchOgText(fetchImpl as never, 'https://apnews.com/x')).toBeNull();
  });

  it('returns null when body has no title / og:title', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`<html><body><h1>hi</h1></body></html>`, { status: 200 }),
    );
    expect(await fetchOgText(fetchImpl as never, 'https://apnews.com/x')).toBeNull();
  });

  // Round-1 reviewer MED 2 — opinion-path URLs on reputable hosts
  // must be rejected inside fetchOgText too, not just at classifyUrl
  // time. A DB-sourced URL (gdelt_event_cluster_outlet) can bypass
  // the classify-time check.
  it('rejects a reputable-host URL whose path is in exclude_prefixes', async () => {
    const fetchImpl = vi.fn();
    // NYT /opinion/ excluded.
    const nytOpinion = await fetchOgText(
      fetchImpl as never,
      'https://www.nytimes.com/opinion/column.html',
    );
    expect(nytOpinion).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Reuters /commentary/ excluded.
    const reutersCommentary = await fetchOgText(
      fetchImpl as never,
      'https://www.reuters.com/commentary/column',
    );
    expect(reutersCommentary).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Guardian /commentisfree/ excluded.
    const guardianCommentisfree = await fetchOgText(
      fetchImpl as never,
      'https://www.theguardian.com/commentisfree/column',
    );
    expect(guardianCommentisfree).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a redirect from a news URL to an opinion-path URL on the same outlet', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://www.nytimes.com/opinion/column.html' },
        }),
    );
    const result = await fetchOgText(
      fetchImpl as never,
      'https://www.nytimes.com/2026/us/politics/story',
    );
    expect(result).toBeNull();
  });

  // Round-2 reviewer MED 7 — host-exact-match. `lookupOutlet` admits
  // suffix matches (edition.cnn.com → cnn.com), which is correct for
  // classifyUrl's broader allowlist check, but UNSAFE at the fetch
  // boundary where we're about to consume the body as evidence. A
  // crafted deep subdomain (via DNS wildcard / subdomain takeover)
  // must be rejected.
  it('rejects a deep subdomain of a reputable host (round-2 MED 7)', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOgText(fetchImpl as never, 'https://evil.subdomain.cnn.com/story');
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts the apex host AND www.<apex>, rejects a deeper subdomain', async () => {
    const html = `<title>ok</title>`;
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    // apex
    expect(await fetchOgText(fetchImpl as never, 'https://cnn.com/politics/x')).not.toBeNull();
    // www. (allowed per operator spec)
    expect(await fetchOgText(fetchImpl as never, 'https://www.cnn.com/politics/x')).not.toBeNull();
    // single subdomain beyond www (edition.cnn.com) — rejected
    const edition = await fetchOgText(fetchImpl as never, 'https://edition.cnn.com/politics/x');
    expect(edition).toBeNull();
  });

  it('rejects a redirect that lands on a deep subdomain of the same reputable host', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://www.cnn.com/a') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://evil.subdomain.cnn.com/pwn' },
        });
      }
      return new Response(`<title>should-not-serve</title>`, { status: 200 });
    });
    const result = await fetchOgText(fetchImpl as never, 'https://www.cnn.com/a');
    expect(result).toBeNull();
  });

  // Round-2 reviewer MED 9 — extractTitle/Description must handle a
  // 2 MiB input in bounded time. The non-backtracking two-stage parser
  // walks each <meta> tag at most once per outer match + once per
  // attribute search on a 4 KiB-bounded tag body.
  it('extractTitle / extractDescription complete quickly on a pathological 2 MiB input (round-2 MED 9)', () => {
    // 2 MiB of <meta attr="x"> with no og:title / og:description —
    // the parser must walk every meta tag once but never backtrack.
    const nonMatching = '<meta attr="x">'.repeat(130_000); // ~2 MiB
    const start = Date.now();
    expect(extractTitle(nonMatching)).toBeNull();
    expect(extractDescription(nonMatching)).toBeNull();
    const elapsed = Date.now() - start;
    // Linear scan on 2 MiB with 15-char tag width = ~130 000 iterations.
    // 1-second cap is wildly loose — a backtracking regex would blow past
    // this on crafted input.
    expect(elapsed).toBeLessThan(1000);
  });

  it('extractTitle still finds og:title in a worst-case body ending with it', () => {
    const prefix = '<meta attr="x">'.repeat(50_000); // ~750 KiB of distraction
    const html = `${prefix}<meta property="og:title" content="Final headline">`;
    expect(extractTitle(html)).toBe('Final headline');
  });

  // Round-1 reviewer MED 1 — readBodyText fallback branch must count
  // BYTES, not UTF-16 code units. A CJK/emoji-heavy body can exceed
  // the byte cap while its String .length is under.
  it('readBodyText fallback branch rejects a body whose BYTE size exceeds the cap even if .length does not', async () => {
    // Build a body that is < 2 MiB in UTF-16 code units but > 2 MiB in UTF-8 bytes.
    // Each "🎯" is 1 code unit pair (surrogate) = 2 .length units but 4 UTF-8 bytes.
    // 600_000 of them: .length = 1_200_000; bytes = 2_400_000 (> 2 MiB).
    const emojiBody = '🎯'.repeat(600_000) + '<title>should-not-matter</title>';
    // Response with no body property (triggers the fallback branch).
    const noBodyResp = {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
      async arrayBuffer() {
        return new TextEncoder().encode(emojiBody).buffer;
      },
      async text() {
        return emojiBody;
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => noBodyResp);
    const result = await fetchOgText(fetchImpl as never, 'https://apnews.com/x');
    // The oversized body is rejected despite having a <title>.
    expect(result).toBeNull();
  });
});

describe('fetchFirstReadable — walks candidates until one succeeds', () => {
  it('tries candidates in order; returns the first readable', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('reuters.com/err')) return new Response('', { status: 500 });
      if (url.includes('apnews.com/ok'))
        return new Response(`<title>AP page</title>`, { status: 200 });
      return new Response(`<title>other</title>`, { status: 200 });
    });
    const result = await fetchFirstReadable(fetchImpl as never, [
      { url: 'https://www.reuters.com/err', host: 'reuters.com' },
      { url: 'https://apnews.com/ok', host: 'apnews.com' },
      { url: 'https://www.nytimes.com/x', host: 'nytimes.com' },
    ]);
    expect(result?.host).toBe('apnews.com');
  });

  it('caps attempts at maxAttempts (default 3)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = await fetchFirstReadable(
      fetchImpl as never,
      [
        { url: 'https://apnews.com/1', host: 'apnews.com' },
        { url: 'https://www.reuters.com/2', host: 'reuters.com' },
        { url: 'https://www.nytimes.com/3', host: 'nytimes.com' },
        { url: 'https://www.washingtonpost.com/4', host: 'washingtonpost.com' },
      ],
      3,
    );
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns null when no candidates succeed', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = await fetchFirstReadable(fetchImpl as never, [
      { url: 'https://apnews.com/1', host: 'apnews.com' },
    ]);
    expect(result).toBeNull();
  });
});
