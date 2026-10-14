// Drop news-sourcing host classification — the §1 non-negotiable made
// structural for source selection.
//
// This file is intentionally not behavior + tests; it is THE CONTRACT
// that the pipeline's host-allow-list / ban-list is held to. Changes
// here change which sources Diktat treats as truth-eligible. Any edit
// must pass:
//   1. copy-linter (any user-facing host display string)
//   2. neutrality-auditor (the allow/ban shape still trust-up; the
//      eleven-bucket categorization still neutral)
//   3. security-reviewer (no SSRF / open-redirect surface introduced
//      by adding a new host pattern)
//   4. Manual neutrality review
//
// MASTER_PLAN.md §1 + CLAUDE.md non-negotiable:
//   "Community + AI fact-checks. Primary sources only — no MSM as
//    truth source."
//
// Pairs with packages/ai-fabric/src/prompts/fact-check.ts — the two
// files MUST stay in sync. The fact-check PRIMARY list and the Drop
// PRIMARY allow-list have the same denotation; the fact-check NOT-
// TRUTH list and the Drop BAN list have the same denotation. Edits
// touching one and not the other are a contract drift and the
// neutrality-auditor will flag them.

import {
  isExcludedPath,
  lookupOutlet,
  type OutletGroup,
  type OutletLean,
  type OutletType,
} from '@diktat/shared/news-outlets';

/**
 * The eleven source-category buckets — schema-side CHECK on
 * news_topics_candidates.source_category enforces these exact values.
 * Adding a new bucket requires a migration to drop+recreate the CHECK
 * (Postgres has no ALTER CHECK MEMBER) plus an update here. Keep them
 * in lockstep.
 */
export const SOURCE_CATEGORIES = [
  'congress',
  'fed_economic',
  'bls_labor',
  'cdc_health',
  'sec_filings',
  'cbo_fiscal',
  'scotus_judicial',
  'census_demographic',
  'doj_legal',
  'fed_monetary',
  'state_election',
  // 'news' is the catch-all category for S1-tier='reputable' outlets
  // (CNN, NYT, WaPo, WSJ, Reuters, AP, …). Reputable-tier candidates
  // don't carry a topical primary-source bucket; the structural signal
  // is `evidence_tier`. The schema CHECK on
  // news_topics_candidates.source_category admits 'news' per migration
  // 20261016000000.
  'news',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

interface HostPattern {
  /** Match host exactly OR as a subdomain (e.g. 'congress.gov' matches
   *  'congress.gov' and 'www.congress.gov' and 'foo.congress.gov'). */
  readonly hostSuffix: string;
  readonly category: SourceCategory;
}

/**
 * PRIMARY-source allow-list. A URL whose host matches one of these
 * patterns IS truth-eligible and CAN populate
 * news_topics.primary_source_url. Mirrors the fact-check.ts PRIMARY
 * SOURCES list — government-operated hosts only.
 *
 * Multi-bucket hosts (e.g. federalreserve.gov is both fed_economic and
 * fed_monetary depending on the path) are mapped to their PRIMARY
 * bucket here; the adapter for that source overrides via the
 * source_category written into the candidate row.
 *
 * State election commissions: V1 ships no state-election adapter.
 * Pattern-match for `secretary of state` / state election hosts is
 * defer-to-v2 along with the adapter. The category exists in the
 * schema CHECK for forward-compat.
 */
export const PRIMARY_ALLOW_LIST: ReadonlyArray<HostPattern> = [
  // Congress + bill / vote data
  { hostSuffix: 'congress.gov', category: 'congress' },
  { hostSuffix: 'house.gov', category: 'congress' },
  { hostSuffix: 'senate.gov', category: 'congress' },
  { hostSuffix: 'govinfo.gov', category: 'congress' },

  // Federal Reserve System — economic data
  { hostSuffix: 'fred.stlouisfed.org', category: 'fed_economic' },
  { hostSuffix: 'stlouisfed.org', category: 'fed_economic' },
  { hostSuffix: 'federalreserve.gov', category: 'fed_monetary' },
  { hostSuffix: 'bea.gov', category: 'fed_economic' },

  // Labor — Bureau of Labor Statistics + Department of Labor
  { hostSuffix: 'bls.gov', category: 'bls_labor' },
  { hostSuffix: 'dol.gov', category: 'bls_labor' },

  // Health — CDC + parent HHS + WHO (named in fact-check.ts:30)
  { hostSuffix: 'cdc.gov', category: 'cdc_health' },
  { hostSuffix: 'hhs.gov', category: 'cdc_health' },
  { hostSuffix: 'fda.gov', category: 'cdc_health' },
  { hostSuffix: 'nih.gov', category: 'cdc_health' },
  { hostSuffix: 'who.int', category: 'cdc_health' },

  // SEC + EDGAR filings
  { hostSuffix: 'sec.gov', category: 'sec_filings' },

  // CBO + Treasury fiscal
  { hostSuffix: 'cbo.gov', category: 'cbo_fiscal' },
  { hostSuffix: 'treasury.gov', category: 'cbo_fiscal' },

  // Federal courts — SCOTUS + circuits
  { hostSuffix: 'supremecourt.gov', category: 'scotus_judicial' },
  { hostSuffix: 'uscourts.gov', category: 'scotus_judicial' },

  // C-SPAN archive (named in fact-check.ts:33 "C-SPAN archive and official
  // agency video archives"). Non-government but explicitly primary-eligible
  // per the contract.
  { hostSuffix: 'c-span.org', category: 'congress' },

  // Census
  { hostSuffix: 'census.gov', category: 'census_demographic' },

  // DOJ + FBI + sub-agencies
  { hostSuffix: 'justice.gov', category: 'doj_legal' },
  { hostSuffix: 'fbi.gov', category: 'doj_legal' },
  { hostSuffix: 'atf.gov', category: 'doj_legal' },
  { hostSuffix: 'dea.gov', category: 'doj_legal' },

  // Elections infrastructure (federal — state SOS hosts deferred to v2)
  { hostSuffix: 'eac.gov', category: 'state_election' },
  { hostSuffix: 'fec.gov', category: 'state_election' },
];

/**
 * BAN list — mirrors fact-check.ts NOT TRUTH SOURCES list verbatim,
 * MINUS the outlets that landed in the S1+S3 reputable-tier allowlist
 * (packages/shared/src/news-outlets.ts). As of migration 20261016000000:
 * CNN, NYT, Washington Post, and WSJ have been removed from this
 * ban list — they are now reputable-tier evidence sources on Drops
 * with no primary document, gated by the S3 ≥2-groups-of-3 outlet-
 * balance guard. The MSM-ban non-negotiable is REPLACED by the
 * tier+balance invariant (operator decision 2026-10-13).
 *
 * Hosts STILL on this list are either (a) opinion-first with factual
 * ratings below the 'Mostly Factual' floor, OR (b) not approved for
 * the reputable-tier allowlist by the operator. They remain usable
 * ONLY as role='framing' (additional context), never as evidence.
 * Enforced by classifyUrl() returning { allowed: false } for any
 * matching host.
 *
 * Per the §1 contract: "they can be referenced as framing ('here's
 * how [outlet] framed it') but never as truth source."
 */
export const MSM_BAN_LIST: ReadonlyArray<string> = [
  // Hosts REMOVED by S1+S3 (now reputable-tier via news-outlets.ts):
  //   cnn.com, nytimes.com, washingtonpost.com, wsj.com
  //
  // Hosts STILL banned (either MBFC-mixed, operator-rejected, or
  // opinion-first with no factual-rating floor pass):
  'foxnews.com',
  'fox.com',
  'foxbusiness.com',
  'msnbc.com',
  'huffpost.com',
  'huffingtonpost.com',
  'dailywire.com',
  'breitbart.com',
  'jacobin.com',
  'jacobinmag.com',
];

/**
 * Classify a URL against the host registries. Four allowed/disallowed
 * outcomes:
 *
 *   - allowed=true, role='primary'    — host is on the PRIMARY allow-
 *                                       list (.gov, courts, c-span).
 *                                       Can populate primary_source_url.
 *                                       evidence_tier='primary'.
 *   - allowed=true, role='reputable'  — host is in the S1+S3 reputable-
 *                                       tier allowlist
 *                                       (packages/shared/src/news-outlets.ts),
 *                                       AND the URL path is NOT an
 *                                       excluded opinion/editorial
 *                                       prefix. evidence_tier='reputable'
 *                                       and the caller receives
 *                                       outlet_lean/group/type for the
 *                                       S3 balance check at Drop time.
 *   - allowed=false, role='framing'   — host is on the MSM ban-list.
 *                                       MAY appear in
 *                                       additional_sources only.
 *   - allowed=false, role='rejected'  — host is on neither list, OR
 *                                       host IS reputable but the URL
 *                                       path matches an opinion /
 *                                       editorial / contributor prefix.
 *                                       Drop pipeline ignores entirely.
 *
 * Opinion-path exclusion: a URL like `https://www.nytimes.com/opinion/x`
 * matches the reputable-host allowlist but hits NYT's `exclude_prefixes`
 * = ['/opinion/', '/live/opinion/']. classifyUrl returns rejected for
 * those — commentary is never evidence on a Drop.
 *
 * Used by the news_ingest handler to gate each candidate URL before
 * it lands in news_topics_candidates. Reject reasons are stamped into
 * the candidate row's rejected_reason for audit.
 */
export type UrlClassification =
  | {
      readonly allowed: true;
      readonly role: 'primary';
      readonly evidence_tier: 'primary' | 'direct';
      readonly category: SourceCategory;
      readonly host: string;
    }
  | {
      readonly allowed: true;
      readonly role: 'reputable';
      readonly evidence_tier: 'reputable';
      readonly category: SourceCategory;
      readonly host: string;
      readonly outlet_lean: OutletLean;
      readonly outlet_group: OutletGroup;
      readonly outlet_type: OutletType;
    }
  | { readonly allowed: false; readonly role: 'framing'; readonly host: string }
  | { readonly allowed: false; readonly role: 'rejected'; readonly host: string }
  | { readonly allowed: false; readonly role: 'invalid'; readonly host: null };

export function classifyUrl(rawUrl: string): UrlClassification {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, role: 'invalid', host: null };
  }
  // Reject anything that isn't HTTPS — primary sources publish over TLS.
  // HTTP fall-through is a sign of either a stale URL or a downgrade
  // attack from an upstream feed.
  if (url.protocol !== 'https:') {
    return { allowed: false, role: 'rejected', host: url.hostname };
  }

  const host = normalizeHost(url.hostname);

  // Primary allowlist wins over everything (operator contract — primary
  // tier is NEVER swapped for a reputable alternative, even if a .gov
  // host were somehow also in the reputable list).
  for (const pat of PRIMARY_ALLOW_LIST) {
    if (hostMatchesSuffix(host, pat.hostSuffix)) {
      return {
        allowed: true,
        role: 'primary',
        evidence_tier: 'primary',
        category: pat.category,
        host,
      };
    }
  }

  // Reputable-tier (S1+S3). The news-outlets allowlist is the second-
  // layer evidence source for Drops with no primary document. Opinion-
  // path exclusion lives on each outlet entry; a matching exclude_prefix
  // demotes the row to rejected (never evidence).
  const outlet = lookupOutlet(host);
  if (outlet !== null) {
    if (isExcludedPath(outlet, rawUrl)) {
      return { allowed: false, role: 'rejected', host };
    }
    return {
      allowed: true,
      role: 'reputable',
      evidence_tier: 'reputable',
      category: 'news',
      host,
      outlet_lean: outlet.lean,
      outlet_group: outlet.group,
      outlet_type: outlet.type,
    };
  }

  // MSM ban-list — hosts explicitly flagged for framing-only use. Falls
  // AFTER the reputable check so an outlet that lands on both lists
  // (shouldn't happen post-migration-20261016000000, but defensive)
  // prefers reputable.
  if (matchesAnySuffix(host, MSM_BAN_LIST)) {
    return { allowed: false, role: 'framing', host };
  }

  return { allowed: false, role: 'rejected', host };
}

/** Lowercased + www-stripped host for stable matching. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  // Exact match OR proper subdomain (boundary on a dot). Prevents
  // 'notcongress.gov' from matching 'congress.gov'.
  if (host === suffix) return true;
  return host.endsWith(`.${suffix}`);
}

function matchesAnySuffix(host: string, suffixes: ReadonlyArray<string>): boolean {
  return suffixes.some((s) => hostMatchesSuffix(host, s));
}
