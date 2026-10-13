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
