// Server-side source-quality classifier used by the fact-check
// orchestrator to stamp each returned source URL with one of
//
//   primary      → .gov / .mil host (U.S. government, official primary)
//   allowlisted  → host present on the news-outlets.ts reputable-tier
//                  allowlist (`lookupOutlet(host) !== null`)
//   other        → anything else (independent blogs, foreign domains,
//                  commercial case-law hosts, etc.)
//
// Why not trust the model: the Perplexity Sonar response includes any
// cited URLs, but we must NOT trust the model's self-report of source
// quality. The classifier runs server-side after the HEAD-gate so a
// prompt-injection or model drift can't elevate a non-primary host.
//
// The `authoritative` flag on `fact_check_verdicts` is false whenever
// EVERY persisted source is `other`, matching the operator contract
// "a supported/refuted verdict whose sources are all `other` must be
// persisted as non-authoritative (same treatment as retrieval_mode=
// 'none')".

import { lookupOutlet } from '@diktat/shared/news-outlets';

export type SourceQuality = 'primary' | 'allowlisted' | 'other';

/**
 * Classify a source URL by its host.
 *
 * Malformed URLs, non-http(s) schemes, and empty strings → `other` by
 * default (same shape as the HEAD-gate's reject posture). The caller
 * does not need a separate try/catch — classifier never throws.
 */
export function classifySourceQuality(url: string): SourceQuality {
  if (typeof url !== 'string' || url.length === 0) return 'other';
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'other';
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'other';
  }
  if (host.endsWith('.gov') || host.endsWith('.mil')) return 'primary';
  // Trailing-dot FQDN edge case: `example.gov.` is a valid absolute
  // host representation that `URL` keeps. Normalise.
  if (host.endsWith('.gov.') || host.endsWith('.mil.')) return 'primary';
  if (lookupOutlet(host) !== null) return 'allowlisted';
  return 'other';
}

/**
 * Compute the overall `authoritative` flag for a verdict.
 *
 * Not authoritative when:
 *   - the model answered from memory (retrieval_mode === 'none'); OR
 *   - every source stamp is `other` (even on a Perplexity-grounded call).
 *
 * The empty-sources case is treated as NOT authoritative — a
 * supported/refuted verdict with no sources at all cannot be rendered as
 * authoritative. (The prompt schema forbids this shape anyway; this is
 * defence-in-depth against future refine drift.)
 */
export function deriveAuthoritative(
  retrievalMode: 'none' | 'perplexity',
  sourceQualities: ReadonlyArray<SourceQuality>,
): boolean {
  if (retrievalMode !== 'perplexity') return false;
  if (sourceQualities.length === 0) return false;
  return sourceQualities.some((q) => q !== 'other');
}
