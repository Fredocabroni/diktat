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

import {
  PAYWALL_FREE_PREFERRED_HOSTS,
  isExcludedPath,
  lookupOutlet,
} from '@diktat/shared/news-outlets';

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
    // Allowlist check — three gates, all three must pass.
    //   (a) `lookupOutlet` resolves the hostname against one of the
    //       30 outlets (suffix-match for www. / subdomain tolerance).
    //   (b) The *resolved* outlet's hostname must be an EXACT match
    //       for `outlet.domain` or `www.<outlet.domain>` — not any
    //       deeper subdomain. Closes PR #214 round-2 reviewer MED 7:
    //       `lookupOutlet`'s suffix match admits
    //       `evil.subdomain.cnn.com` → `cnn.com`, which an attacker
    //       could reach via DNS wildcard / subdomain takeover and
    //       serve crafted og:title. The suffix-match is appropriate
    //       for `www.<x>` / `edition.<x>` normalisation inside
    //       classifyUrl's broader check; here, where we're about to
    //       fetch and consume the body as evidence, we require an
    //       exact apex match.
    //   (c) The outlet is news-type (commentary never carries evidence).
    //   (d) The URL path does NOT match any opinion / editorial /
    //       contributor prefix on that outlet (closes round-1 MED 2).
    const outlet = lookupOutlet(parsed.hostname);
    if (outlet === null) return null;
    const normalizedHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (normalizedHost !== outlet.domain) return null;
    if (outlet.type !== 'news') return null;
    if (isExcludedPath(outlet, parsed.toString())) return null;

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

/** Read response body as text with an incremental BYTE-count cap.
 *  Closes PR #214 round-1 reviewer MED 1 — the earlier fallback-
 *  branch used `.length` (UTF-16 code units) which lets a CJK /
 *  emoji-heavy body pass a 2 MiB cap with ~6 MiB of actual bytes.
 *  Both branches now count bytes. */
async function readBodyText(response: Response, maxBytes: number): Promise<string | null> {
  try {
    if (!response.body) {
      // Fallback: no streamable body (polyfill / test shim). Pull as
      // ArrayBuffer so we can check byte length BEFORE decoding to
      // string.
      const ab = await response.arrayBuffer();
      if (ab.byteLength > maxBytes) return null;
      return new TextDecoder('utf-8').decode(ab);
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

/** Max bytes of a single <meta ...> or <title ...> tag we're willing
 *  to parse. Legit tags are a few hundred bytes; capping here bounds
 *  the inner-regex work on a per-tag basis so a pathological body
 *  can't push any one match toward quadratic behaviour. 4 KiB per tag
 *  is wildly generous — real og:title values are tens of bytes. The
 *  value is baked into the regex literals below (JS RegExp quantifier
 *  bounds must be literal integers, not variables). */

/** Two-stage, non-backtracking meta-tag parser.
 *
 *  Replaces the earlier `<meta[^>]+property...["']([^"']+)["']` single-
 *  regex approach (closes PR #214 round-2 reviewer MED 9: nested
 *  character-class alternation under JS regex engines can degrade to
 *  O(n²) on crafted input where many partial matches of
 *  `property\s*=\s*["']og:title["']` are abandoned mid-regex).
 *
 *  Stage 1: `<meta ... >` splitter. `[^>]*` on `<meta` only; no inner
 *  back-tracking across the attribute space. A `g` flag + per-match
 *  index advance guarantees linear scan over the body.
 *
 *  Stage 2: for each extracted tag (bounded at META_TAG_MAX_CHARS),
 *  pull out two attribute values via simple non-nested regexes. These
 *  work against the SMALL per-tag string, not the full body, so even
 *  if an attribute regex has mild backtracking the work is bounded. */
export function extractTitle(html: string): string | null {
  const og = findMetaByAttr(html, 'property', 'og:title');
  if (og !== null) return decodeHtmlEntities(og.trim());
  // <title> fallback — the tag is small by convention; lazy content
  // match on `[\s\S]*?` has no backtracking surface on a well-formed
  // page. Cap after .exec() in case of a pathological unterminated tag.
  const t = /<title[^>]*>([\s\S]{0,8192}?)<\/title>/i.exec(html);
  if (t && t[1]) return decodeHtmlEntities(t[1].trim());
  return null;
}

export function extractDescription(html: string): string | null {
  const og = findMetaByAttr(html, 'property', 'og:description');
  if (og !== null) return decodeHtmlEntities(og.trim());
  const name = findMetaByAttr(html, 'name', 'description');
  if (name !== null) return decodeHtmlEntities(name.trim());
  return null;
}

/** Walk every `<meta ...>` tag in the body (bounded by
 *  META_TAG_MAX_CHARS each) and return the `content` attribute of
 *  the first one whose `attrName="attrValue"` pair matches. Returns
 *  null if no tag matches. */
function findMetaByAttr(html: string, attrName: string, attrValue: string): string | null {
  // Compile the attribute-match regex ONCE per call, not per matched
  // meta tag. The earlier shape recompiled on every iteration (~390k
  // compiles on the MED 9 pathological 2 MiB input) — PR #214 round-3
  // CI timing failure. Attribute-lookup regex is bounded against the
  // small 4 KiB tag body `inside`, so even if the character class
  // allows mild backtracking the work is bounded.
  const nameRe = new RegExp(
    `\\b${escapeRegex(attrName)}\\s*=\\s*(?:"${escapeRegex(attrValue)}"|'${escapeRegex(attrValue)}')`,
    'i',
  );
  // Linear scan: match each <meta ...> opening-tag boundary. The
  // inner `[^>]{0,META_TAG_MAX_CHARS}` is bounded, so the engine
  // can't take super-linear time per match.
  const metaIter = html.matchAll(/<meta([^>]{0,4096})>/gi);
  for (const match of metaIter) {
    const inside = match[1] ?? '';
    if (!nameRe.test(inside)) continue;
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]{0,4096})"|'([^']{0,4096})')/i.exec(inside);
    if (!contentMatch) continue;
    const value = contentMatch[1] ?? contentMatch[2] ?? '';
    if (value.length === 0) continue;
    return value;
  }
  return null;
}

/** Escape user-supplied text for safe literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
