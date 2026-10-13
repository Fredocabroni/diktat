// Lazy text fetch for the S3 reputable-tier evidence source. GDELT's
// raw mentions export (data.gdeltproject.org/.../mentions.CSV.zip)
// does not carry article titles or summaries; the Drop pipeline needs
// og:title + og:description (or <title> + <meta name=description>)
// from allowlisted news-type outlets to drive the headline-rewrite +
// fact-explainer. "Working from URL alone" is a hallucination risk —
// if NO allowlisted news-type outlet yields readable text, the
// cluster is NOT eligible for Drop this cycle.
//
// Operator spec (2026-10-13):
//   - prefer non-paywalled news outlets (AP, Reuters, NPR, BBC, Axios,
//     The Hill — the PAYWALL_FREE_PREFERRED_HOSTS set).
//   - SSRF-safe: allowlisted hosts only, https, size cap, timeout, no
//     redirects to non-allowlisted hosts.
//   - If no readable text from ≥1 news-type outlet → not eligible.
//
// Not integrated into drop-publish in this PR; the function + types
// land first so the integration follow-up is pure wiring.

import { PAYWALL_FREE_PREFERRED_HOSTS, lookupOutlet } from '@diktat/shared/news-outlets';

/** Fetch per-URL timeout. News outlets usually respond within 2 s on
 *  the happy path; 10 s tolerates slow TLS handshake / server mood. */
export const DROP_TEXT_FETCH_TIMEOUT_MS = 10_000;

/** Body size cap. Legit article HTML is tens of KB; 2 MiB bounds a
 *  pathological upstream shipping multi-MB of embedded video /
 *  tracking JavaScript before the parser gives up. */
export const DROP_TEXT_FETCH_MAX_BYTES = 2 * 1024 * 1024;

/** Max redirects per fetch. News outlets commonly do one hop
 *  (www → non-www, or http → https). Two gives slack for the mobile-
 *  landing-page pattern (e.g. nytimes.com → m.nytimes.com); more is
 *  suspicious. */
export const DROP_TEXT_FETCH_MAX_REDIRECTS = 2;

/** Max title / description bytes to keep from the HTML. Caps at Drop-
 *  card display budget so a hostile page can't ship a 10 MB <title>. */
export const DROP_TEXT_FETCH_MAX_TITLE_CHARS = 300;
export const DROP_TEXT_FETCH_MAX_DESCRIPTION_CHARS = 1000;

export interface DropTextSource {
  readonly url: string;
  readonly host: string;
  readonly title: string;
  readonly description: string | null;
}

export interface GdeltClusterOutletRow {
  readonly url: string;
  readonly host: string;
  readonly outlet_type: 'news' | 'commentary' | null;
}

/** Order the cluster's outlet rows into a priority list for the lazy
 *  text fetch. Priority:
 *    1. Paywall-free preferred news hosts (operator-ordered)
 *    2. Other news-type outlets (preserve insertion order)
 *  Commentary outlets are EXCLUDED — commentary never carries the
 *  Drop evidence text, per operator spec.
 *
 *  `bestNewsUrl` (from `gdelt_event_cluster.best_news_url`) is picked
 *  as a first-pass hint from the per-mention sink; if present AND
 *  the host is on the preferred list, it goes first. */
export function pickTextSources(
  outlets: ReadonlyArray<GdeltClusterOutletRow>,
  bestNewsUrl: string | null,
  bestNewsHost: string | null,
): ReadonlyArray<{ url: string; host: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; host: string }> = [];

  const push = (url: string, host: string): void => {
    const key = `${host}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, host });
  };

  // 1. bestNewsUrl first if preferred.
  if (
    bestNewsUrl !== null &&
    bestNewsHost !== null &&
    PAYWALL_FREE_PREFERRED_HOSTS.includes(bestNewsHost)
  ) {
    push(bestNewsUrl, bestNewsHost);
  }

  // 2. Preferred-order sweep across cluster outlets.
  for (const preferred of PAYWALL_FREE_PREFERRED_HOSTS) {
    for (const o of outlets) {
      if (o.outlet_type !== 'news') continue;
      if (o.host !== preferred) continue;
      push(o.url, o.host);
    }
  }

  // 3. Remaining news-type outlets (any news-type host not already picked).
  for (const o of outlets) {
    if (o.outlet_type !== 'news') continue;
    push(o.url, o.host);
  }

  return out;
}

/** Fetch a URL from an allowlisted news-type outlet and extract its
 *  og:title + og:description (or <title> + meta description).
 *  Returns null if:
 *    - the host is not on the news-outlets allowlist, or
 *    - the fetch fails / times out, or
 *    - no title tag is found in the body.
 *
 *  SSRF defense: hostname validated against lookupOutlet BEFORE the
 *  fetch; non-matching hosts error immediately. redirect='manual' and
 *  any 3xx is followed only if its Location points at another
 *  allowlisted host (via a bounded manual loop). */
export async function fetchOgText(
  fetchImpl: typeof globalThis.fetch,
  url: string,
): Promise<DropTextSource | null> {
  // Walk up to MAX_REDIRECTS, re-validating the host on each hop.
  let currentUrl = url;
  for (let hop = 0; hop <= DROP_TEXT_FETCH_MAX_REDIRECTS; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    // Allowlist check — must resolve to one of the 30 outlets.
    const outlet = lookupOutlet(parsed.hostname);
    if (outlet === null) return null;
    if (outlet.type !== 'news') return null;

    let response: Response;
    try {
      response = await fetchImpl(parsed.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(DROP_TEXT_FETCH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (loc === null) return null;
      // Resolve relative redirects against the current URL.
      try {
        currentUrl = new URL(loc, currentUrl).toString();
      } catch {
        return null;
      }
      continue; // next hop
    }
    if (!response.ok) return null;

    // Read body with size cap.
    const bodyText = await readBodyText(response, DROP_TEXT_FETCH_MAX_BYTES);
    if (bodyText === null) return null;

    const title = extractTitle(bodyText);
    if (title === null) return null;
    const description = extractDescription(bodyText);

    return {
      url: parsed.toString(),
      host: parsed.hostname.toLowerCase().replace(/^www\./, ''),
      title: title.slice(0, DROP_TEXT_FETCH_MAX_TITLE_CHARS),
      description:
        description === null ? null : description.slice(0, DROP_TEXT_FETCH_MAX_DESCRIPTION_CHARS),
    };
  }
  // Too many hops.
  return null;
}

/** Walk a list of candidate URLs; return the first fetchOgText that
 *  yields readable text. Caps the number of attempts (operator spec:
 *  up to 3 news-type URLs before giving up on the cluster). */
export async function fetchFirstReadable(
  fetchImpl: typeof globalThis.fetch,
  candidates: ReadonlyArray<{ url: string; host: string }>,
  maxAttempts = 3,
): Promise<DropTextSource | null> {
  const limit = Math.min(candidates.length, maxAttempts);
  for (let i = 0; i < limit; i += 1) {
    const c = candidates[i]!;
    const text = await fetchOgText(fetchImpl, c.url);
    if (text !== null) return text;
  }
  return null;
}

/** Read response body as text with an incremental size cap. */
async function readBodyText(response: Response, maxBytes: number): Promise<string | null> {
  try {
    if (!response.body) {
      const buffered = await response.text();
      if (buffered.length > maxBytes) return null;
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
        return null;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  } catch {
    return null;
  }
}

/** Prefer og:title; fall back to <title>. Both regexes are
 *  intentionally lenient (whitespace / quoting variants). */
export function extractTitle(html: string): string | null {
  const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["']/i.exec(
    html,
  );
  if (og && og[1]) return decodeHtmlEntities(og[1].trim());
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t && t[1]) return decodeHtmlEntities(t[1].trim());
  return null;
}

/** Prefer og:description; fall back to <meta name="description">. */
export function extractDescription(html: string): string | null {
  const og =
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]+content\s*=\s*["']([^"']+)["']/i.exec(
      html,
    );
  if (og && og[1]) return decodeHtmlEntities(og[1].trim());
  const d = /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']+)["']/i.exec(
    html,
  );
  if (d && d[1]) return decodeHtmlEntities(d[1].trim());
  return null;
}

/** Minimal HTML entity decode — covers the five entities that commonly
 *  survive into og:* and <meta> content. Everything else passes through. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
