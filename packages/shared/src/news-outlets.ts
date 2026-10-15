// S1 + S3 — curated news-outlet allowlist for GDELT trending (operator-
// approved 2026-10-13).
//
// This module is the source of truth for which "reputable" news outlets
// qualify as evidence sources on Drops with no primary document. Every
// entry carries:
//   - domain:          host-suffix match (so `www.<domain>` matches too)
//   - lean:            AllSides v9 (5-level: left / lean-left / center /
//                      lean-right / right)
//   - group:           derived from lean per operator spec —
//                      left + lean-left → 'left'; center → 'center';
//                      lean-right + right → 'right'
//   - type:            'news' (reporting-first) | 'commentary' (opinion-
//                      first). Commentary counts for trend_score + the
//                      ≥2-groups balance signal, but is NEVER the Drop
//                      card link.
//   - mbfc_factual:    MBFC's factual-reporting rating. Floor is
//                      'Mostly Factual' or better (High / Very High).
//                      No 'Mixed' / 'Low' / 'Very Low' entries ship.
//   - allsides_url:    public AllSides page link (per-outlet citation).
//   - mbfc_url:        public MBFC page link (per-outlet citation).
//   - exclude_prefixes: URL path prefixes that mark opinion / editorial
//                      / contributor content. Any matching URL is
//                      rejected by classifyUrl.
//
// Licensing: AllSides data for commercial use requires a Pro license,
// MBFC Pro likewise. A 30-outlet hand-curated list with per-outlet
// citation is on the commentary / fair-use side of the line; the
// AllSides-API path and >50-outlet expansions will need Pro tier.
//
// Ratings as of: AllSides v9 chart + MBFC public pages as surveyed on
// 2026-10-13. Ratings drift over time; a periodic verifier sweep is
// queued in the follow-up pipeline.

export type OutletLean = 'left' | 'lean-left' | 'center' | 'lean-right' | 'right';
export type OutletGroup = 'left' | 'center' | 'right';
export type OutletType = 'news' | 'commentary';

export interface Outlet {
  /** Lowercase canonical apex host. Matched against `url.hostname`
   *  via host-suffix equality (so `www.<domain>` and `edition.<domain>`
   *  both match `<domain>`). */
  readonly domain: string;
  /** Additional apex hosts that resolve to the SAME outlet entry.
   *  For an outlet published under multiple TLDs (BBC: bbc.com +
   *  bbc.co.uk), list the non-canonical form(s) here. Each alias is
   *  treated the same as `domain` by `lookupOutlet` and `isApexHost`
   *  — it is an apex, not a subdomain. 2026-10-14 prod read-only
   *  observation: GDELT's mentions stream uses `bbc.co.uk` 25× more
   *  often than `bbc.com`; without this alias the BBC entry would
   *  miss ~96% of GDELT's BBC coverage. */
  readonly aliases?: ReadonlyArray<string>;
  readonly lean: OutletLean;
  readonly group: OutletGroup;
  readonly type: OutletType;
  /** MBFC factual-reporting rating, exact string as published. */
  readonly mbfc_factual: 'Very High' | 'High' | 'Mostly Factual';
  readonly allsides_url: string;
  readonly mbfc_url: string;
  /** URL path prefixes that mark opinion / editorial / contributor
   *  content. Matching URLs are rejected by classifyUrl so a Drop
   *  never cites commentary as evidence. */
  readonly exclude_prefixes: ReadonlyArray<string>;
}

/** AllSides v9 → operator-defined 3-group collapse. */
export function leanToGroup(lean: OutletLean): OutletGroup {
  switch (lean) {
    case 'left':
    case 'lean-left':
      return 'left';
    case 'center':
      return 'center';
    case 'lean-right':
    case 'right':
      return 'right';
  }
}

// ---------------------------------------------------------------------------
// The 30-outlet starter list
// ---------------------------------------------------------------------------
//
// Group balance: 10 left · 10 center · 10 right. AP + Reuters anchor
// Center (wire services). American Conservative moved to Lean Right
// (AllSides April-2026 update). Hot Air DROPPED per operator (not rated
// by AllSides). Forbes DROPPED (MBFC Mixed on main site). The Free Press
// DROPPED (MBFC Mixed). MarketWatch + Investor's Business Daily added
// as replacements. See the S1+S3 recon in the operator thread for the
// per-outlet source links.

export const OUTLETS: ReadonlyArray<Outlet> = [
  // ======== LEFT GROUP (10) =========
  {
    domain: 'motherjones.com',
    lean: 'left',
    group: 'left',
    type: 'commentary',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/mother-jones-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/mother-jones/',
    exclude_prefixes: [],
  },
  {
    domain: 'vox.com',
    lean: 'left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/vox-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/vox/',
    exclude_prefixes: ['/the-highlight/', '/first-person/'],
  },
  {
    domain: 'thenation.com',
    lean: 'left',
    group: 'left',
    type: 'commentary',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/nation-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-nation/',
    exclude_prefixes: [],
  },
  {
    domain: 'cnn.com',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/cnn-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/cnn/',
    exclude_prefixes: ['/opinion/', '/opinions/'],
  },
  {
    domain: 'nytimes.com',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/new-york-times-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/new-york-times/',
    exclude_prefixes: ['/opinion/', '/live/opinion/'],
  },
  {
    domain: 'washingtonpost.com',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/washington-post-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/washington-post/',
    exclude_prefixes: ['/opinions/', '/opinion/'],
  },
  {
    domain: 'npr.org',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/npr-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/npr/',
    exclude_prefixes: [],
  },
  {
    domain: 'theguardian.com',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/guardian-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-guardian/',
    exclude_prefixes: ['/commentisfree/'],
  },
  {
    domain: 'theatlantic.com',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/atlantic-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-atlantic/',
    exclude_prefixes: ['/ideas/'],
  },
  {
    domain: 'politico.com',
    lean: 'lean-left',
    group: 'left',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/politico-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/politico/',
    exclude_prefixes: ['/opinion/', '/magazine/'],
  },

  // ======== CENTER GROUP (10) =========
  {
    domain: 'apnews.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'Very High',
    allsides_url: 'https://www.allsides.com/news-source/associated-press-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/associated-press/',
    exclude_prefixes: [],
  },
  {
    domain: 'reuters.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'Very High',
    allsides_url: 'https://www.allsides.com/news-source/reuters',
    mbfc_url: 'https://mediabiasfactcheck.com/reuters/',
    exclude_prefixes: ['/commentary/', '/breakingviews/'],
  },
  {
    domain: 'bbc.com',
    // GDELT's mentions stream overwhelmingly uses `bbc.co.uk` (25× more
    // than `bbc.com` per 2026-10-14 prod sample). Keep both forms on
    // the same outlet entry so lookupOutlet + isApexHost resolve them
    // to one BBC record (not two allowlist entries competing for
    // trend-score + S3-group bookkeeping).
    aliases: ['bbc.co.uk'],
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/bbc-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/bbc/',
    exclude_prefixes: [],
  },
  {
    domain: 'axios.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/axios-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/axios/',
    exclude_prefixes: [],
  },
  {
    domain: 'csmonitor.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/christian-science-monitor-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/christian-science-monitor/',
    exclude_prefixes: ['/commentary/'],
  },
  {
    domain: 'bloomberg.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url:
      'https://www.allsides.com/blog/bloomberg-bias-rating-moves-lean-left-center-2026-allsides-update',
    mbfc_url: 'https://mediabiasfactcheck.com/bloomberg/',
    exclude_prefixes: ['/opinion/', '/opinion-interactive/'],
  },
  {
    domain: 'thehill.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/hill-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-hill/',
    exclude_prefixes: ['/opinion/', '/homenews/opinion/'],
  },
  {
    domain: 'marketwatch.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/marketwatch-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/marketwatch/',
    exclude_prefixes: ['/column/', '/story/opinion-'],
  },
  {
    domain: 'newsnationnow.com',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/newsnation-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/newsnation/',
    exclude_prefixes: [],
  },
  {
    domain: 'propublica.org',
    lean: 'center',
    group: 'center',
    type: 'news',
    mbfc_factual: 'Very High',
    allsides_url: 'https://www.allsides.com/news-source/propublica-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/propublica/',
    exclude_prefixes: [],
  },

  // ======== RIGHT GROUP (10) =========
  {
    domain: 'wsj.com',
    lean: 'lean-right',
    group: 'right',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/wall-street-journal-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/wall-street-journal/',
    exclude_prefixes: ['/opinion/', '/articles/opinion/'],
  },
  {
    domain: 'washingtonexaminer.com',
    lean: 'lean-right',
    group: 'right',
    type: 'news',
    mbfc_factual: 'Mostly Factual',
    allsides_url:
      'https://www.allsides.com/blog/washington-examiner-bias-rating-confirmed-lean-right-allsides-survey',
    mbfc_url: 'https://mediabiasfactcheck.com/washington-examiner/',
    exclude_prefixes: ['/opinion/'],
  },
  {
    domain: 'thedispatch.com',
    lean: 'lean-right',
    group: 'right',
    type: 'news',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/dispatch-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-dispatch/',
    exclude_prefixes: [],
  },
  {
    domain: 'reason.com',
    lean: 'lean-right',
    group: 'right',
    type: 'commentary',
    mbfc_factual: 'High',
    allsides_url: 'https://www.allsides.com/news-source/reason-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/reason/',
    exclude_prefixes: [],
  },
  {
    domain: 'investors.com',
    lean: 'lean-right',
    group: 'right',
    type: 'news',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/investors-business-daily',
    mbfc_url: 'https://mediabiasfactcheck.com/investors-business-daily/',
    exclude_prefixes: ['/editorials/'],
  },
  {
    domain: 'theamericanconservative.com',
    lean: 'lean-right',
    group: 'right',
    type: 'commentary',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/american-conservative-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-american-conservative/',
    exclude_prefixes: [],
  },
  {
    domain: 'nationalreview.com',
    lean: 'right',
    group: 'right',
    type: 'commentary',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/national-review-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/national-review/',
    exclude_prefixes: [],
  },
  {
    domain: 'city-journal.org',
    lean: 'right',
    group: 'right',
    type: 'commentary',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/city-journal-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/city-journal/',
    exclude_prefixes: [],
  },
  {
    domain: 'thespectator.com',
    lean: 'right',
    group: 'right',
    type: 'news',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/spectator-world-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/the-spectator-world-bias/',
    exclude_prefixes: ['/comment/', '/culture/'],
  },
  {
    domain: 'spectator.org',
    lean: 'right',
    group: 'right',
    type: 'commentary',
    mbfc_factual: 'Mostly Factual',
    allsides_url: 'https://www.allsides.com/news-source/american-spectator-media-bias',
    mbfc_url: 'https://mediabiasfactcheck.com/american-spectator/',
    exclude_prefixes: [],
  },
];

/** Lazy host → outlet lookup. Case-insensitive; strips a leading
 *  `www.` label so `www.cnn.com` and `cnn.com` both resolve. Returns
 *  null when no outlet matches — classifyUrl treats that as a non-
 *  allowlisted host. */
export function lookupOutlet(hostname: string): Outlet | null {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  // Direct match first (90% of real traffic). Checks the canonical
  // `domain` AND every entry in `aliases` so a multi-TLD outlet
  // (BBC) resolves to the single outlet record under either form.
  for (const o of OUTLETS) {
    if (o.domain === normalized) return o;
    if (o.aliases?.includes(normalized)) return o;
  }
  // Host-suffix match: `edition.cnn.com` → cnn.com. Same alias
  // handling — a mail/edition subdomain under an aliased apex host
  // still resolves (e.g. `news.bbc.co.uk` → BBC outlet via alias).
  for (const o of OUTLETS) {
    if (normalized.endsWith('.' + o.domain)) return o;
    if (o.aliases?.some((alias) => normalized.endsWith('.' + alias))) return o;
  }
  return null;
}

/** Returns true when `hostname` is EXACTLY the outlet's apex: the
 *  canonical `domain`, any entry in `aliases`, or `www.<...>` for
 *  either. A deeper subdomain (`news.bbc.co.uk`, `edition.cnn.com`,
 *  `evil.subdomain.cnn.com`) returns FALSE. Used by `fetchOgText` to
 *  gate the body-consuming fetch — a URL that resolves to an outlet
 *  via `lookupOutlet`'s broader suffix match but is NOT at the apex
 *  must not have its body consumed as evidence (round-2 reviewer
 *  MED 7). */
export function isApexHost(outlet: Outlet, hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  if (normalized === outlet.domain) return true;
  if (outlet.aliases?.includes(normalized)) return true;
  return false;
}

/** Returns true when `url`'s pathname begins with any of the outlet's
 *  `exclude_prefixes`. These prefixes mark opinion / editorial /
 *  contributor content — rejected so commentary never carries a Drop. */
export function isExcludedPath(outlet: Outlet, url: string): boolean {
  if (outlet.exclude_prefixes.length === 0) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  for (const prefix of outlet.exclude_prefixes) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/** Preferred paywall-free news-type hosts for the lazy text-fetch at
 *  Drop time (headline rewrite + fact-explainer input). Order matters
 *  — drop-publish tries these first, in order, before falling back to
 *  other news-type outlets. Operator-approved 2026-10-13: AP, Reuters,
 *  NPR, BBC, Axios, The Hill.
 *
 *  Entries are compared by EXACT normalized host (news-ingest's
 *  `isPaywallFreePreferred` flag and `pickTextSources`' preferred
 *  sweep both use `includes` / `===`), so every alias form an outlet
 *  is actually stored under must be listed. BBC is stored as
 *  `bbc.co.uk` far more often than `bbc.com` (GDELT's dominant form,
 *  see the BBC `aliases` note above); without the alias here, BBC text
 *  was never preferred and `best_news_url` never took a BBC URL. */
export const PAYWALL_FREE_PREFERRED_HOSTS: ReadonlyArray<string> = [
  'apnews.com',
  'reuters.com',
  'npr.org',
  'bbc.com',
  'bbc.co.uk',
  'axios.com',
  'thehill.com',
];
