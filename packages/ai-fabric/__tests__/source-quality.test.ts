// Unit tests for the server-side source-quality classifier used by
// the fact-check orchestrator (P4 batch pre-launch).
//
// The classifier is tiny and pure. These tests pin the three
// classifications + the authoritative-derivation combinator so a
// future refactor can't quietly collapse the primary vs allowlisted
// vs other distinction (operator contract: all-'other' sources on a
// supported/refuted verdict → non-authoritative, same treatment as
// retrieval_mode='none').

import { describe, expect, it } from 'vitest';

import { classifySourceQuality, deriveAuthoritative } from '../src/source-quality.js';

describe('classifySourceQuality', () => {
  it('classifies .gov hosts as primary', () => {
    expect(classifySourceQuality('https://supremecourt.gov/opinions/x.pdf')).toBe('primary');
    expect(classifySourceQuality('https://www.whitehouse.gov/briefing-room/x')).toBe('primary');
    expect(classifySourceQuality('https://bls.gov/news/x.htm')).toBe('primary');
    expect(classifySourceQuality('https://sub.agency.gov/report')).toBe('primary');
  });

  it('classifies .mil hosts as primary', () => {
    expect(classifySourceQuality('https://defense.mil/news/x')).toBe('primary');
  });

  it('classifies a news-outlets.ts allowlisted host as allowlisted', () => {
    // nytimes.com is on the OUTLETS allowlist in packages/shared/
    // news-outlets.ts. The classifier reads that single source of
    // truth via `lookupOutlet`.
    expect(classifySourceQuality('https://nytimes.com/2026/01/01/politics/x.html')).toBe(
      'allowlisted',
    );
    // The classifier strips `www.` so apex and `www.` variants
    // normalise to the same lookup result.
    expect(classifySourceQuality('https://www.nytimes.com/x')).toBe('allowlisted');
  });

  it('classifies anything else as other', () => {
    expect(classifySourceQuality('https://random-blog.example/post')).toBe('other');
    expect(classifySourceQuality('https://casetext.com/case/x')).toBe('other');
    // Commercial case-law host — NOT a .gov despite being court-related.
    expect(classifySourceQuality('https://supreme.justia.com/cases/x.html')).toBe('other');
  });

  it('returns "other" on malformed / non-http(s) / empty URLs (never throws)', () => {
    expect(classifySourceQuality('')).toBe('other');
    expect(classifySourceQuality('not-a-url')).toBe('other');
    expect(classifySourceQuality('javascript:alert(1)')).toBe('other');
    expect(classifySourceQuality('data:text/html,<x>')).toBe('other');
    expect(classifySourceQuality('ftp://example.gov/')).toBe('other');
  });

  it('handles trailing-dot FQDN as primary (edge case)', () => {
    expect(classifySourceQuality('https://whitehouse.gov./')).toBe('primary');
  });
});

describe('deriveAuthoritative', () => {
  it('is false when retrieval_mode is none, even with primary sources', () => {
    // Sonnet-from-memory path: even if the model listed .gov URLs,
    // it didn't actually retrieve them. Not authoritative.
    expect(deriveAuthoritative('none', ['primary', 'primary'])).toBe(false);
  });

  it('is true when retrieval_mode is perplexity AND at least one source is primary or allowlisted', () => {
    expect(deriveAuthoritative('perplexity', ['primary'])).toBe(true);
    expect(deriveAuthoritative('perplexity', ['allowlisted'])).toBe(true);
    expect(deriveAuthoritative('perplexity', ['primary', 'other', 'other'])).toBe(true);
    expect(deriveAuthoritative('perplexity', ['other', 'allowlisted', 'other'])).toBe(true);
  });

  it('is FALSE when retrieval_mode is perplexity but every source is other (operator contract)', () => {
    // The P4 batch spec: "A supported/refuted verdict whose sources
    // are all `other` must be persisted as non-authoritative (same
    // treatment as retrieval_mode='none')."
    expect(deriveAuthoritative('perplexity', ['other'])).toBe(false);
    expect(deriveAuthoritative('perplexity', ['other', 'other', 'other'])).toBe(false);
  });

  it('is false when retrieval_mode is perplexity but there are zero sources', () => {
    // Defence-in-depth: a verdict with no sources can never render
    // authoritative. The Zod schema already permits this shape only
    // for unverifiable/contested — this guard catches a future
    // refine drift that might let supported/refuted through with
    // an empty sources[].
    expect(deriveAuthoritative('perplexity', [])).toBe(false);
  });
});
