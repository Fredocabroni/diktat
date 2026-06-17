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
 * BAN list — mirrors fact-check.ts NOT TRUTH SOURCES list verbatim.
 * Hosts here MAY appear in news_topics.additional_sources with role
 * 'framing', but MUST NEVER populate primary_source_url. Enforced by
 * classifyUrl() returning { allowed: false } for any matching host.
 *
 * Per the §1 contract: "they can be referenced as framing ('here's
 * how [outlet] framed it') but never as truth source."
 */
export const MSM_BAN_LIST: ReadonlyArray<string> = [
  // ABC list from fact-check.ts:35-37 — CNN, Fox, MSNBC, NYT, WaPo,
  // WSJ, HuffPost, Daily Wire, Breitbart, Jacobin
  'cnn.com',
  'foxnews.com',
  'fox.com',
  'foxbusiness.com',
  'msnbc.com',
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'huffpost.com',
  'huffingtonpost.com',
  'dailywire.com',
  'breitbart.com',
  'jacobin.com',
  'jacobinmag.com',
];

/**
 * Classify a URL against the host registries. Three outcomes:
 *
 *   - allowed=true, role='primary'    — host is on the PRIMARY allow-
 *                                       list. Can populate
 *                                       primary_source_url.
 *   - allowed=false, role='framing'   — host is on the MSM ban-list.
 *                                       MAY appear in
 *                                       additional_sources only.
 *   - allowed=false, role='rejected'  — host is on neither list.
 *                                       Drop pipeline ignores entirely
 *                                       (V1 behavior — strict primary-
 *                                       source posture). A future
 *                                       'neutral' bucket (e.g. AP,
 *                                       Reuters wire) would need an
 *                                       explicit founder call to add.
 *
 * Used by the news_ingest handler to gate each candidate URL before
 * it lands in news_topics_candidates. Reject reasons are stamped into
 * the candidate row's rejected_reason for audit.
 */
export type UrlClassification =
  | {
      readonly allowed: true;
      readonly role: 'primary';
      readonly category: SourceCategory;
      readonly host: string;
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

  if (matchesAnySuffix(host, MSM_BAN_LIST)) {
    return { allowed: false, role: 'framing', host };
  }

  for (const pat of PRIMARY_ALLOW_LIST) {
    if (hostMatchesSuffix(host, pat.hostSuffix)) {
      return { allowed: true, role: 'primary', category: pat.category, host };
    }
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
