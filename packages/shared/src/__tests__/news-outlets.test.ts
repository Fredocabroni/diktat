import { describe, expect, it } from 'vitest';

import {
  OUTLETS,
  PAYWALL_FREE_PREFERRED_HOSTS,
  isExcludedPath,
  leanToGroup,
  lookupOutlet,
  type OutletGroup,
} from '../news-outlets.js';

describe('OUTLETS — curated 30-outlet starter list integrity', () => {
  it('has exactly 30 entries', () => {
    expect(OUTLETS).toHaveLength(30);
  });

  it('has unique domains (no duplicates)', () => {
    const seen = new Set<string>();
    for (const o of OUTLETS) {
      expect(seen.has(o.domain)).toBe(false);
      seen.add(o.domain);
    }
  });

  it('every outlet clears the MBFC floor (Mostly Factual or better)', () => {
    const allowed = new Set(['Very High', 'High', 'Mostly Factual']);
    for (const o of OUTLETS) {
      expect(allowed.has(o.mbfc_factual)).toBe(true);
    }
  });

  it('every outlet has an AllSides + MBFC source URL (per-outlet citation)', () => {
    for (const o of OUTLETS) {
      expect(o.allsides_url).toMatch(/^https:\/\//);
      expect(o.mbfc_url).toMatch(/^https:\/\//);
    }
  });

  it('every outlet.group matches leanToGroup(outlet.lean) (operator-defined collapse)', () => {
    for (const o of OUTLETS) {
      expect(o.group).toBe(leanToGroup(o.lean));
    }
  });

  it('is group-balanced: 10 left · 10 center · 10 right (operator-approved)', () => {
    const counts: Record<OutletGroup, number> = { left: 0, center: 0, right: 0 };
    for (const o of OUTLETS) counts[o.group] += 1;
    expect(counts).toEqual({ left: 10, center: 10, right: 10 });
  });

  it('AP + Reuters anchor Center group (wire-service invariant)', () => {
    expect(lookupOutlet('apnews.com')?.group).toBe('center');
    expect(lookupOutlet('reuters.com')?.group).toBe('center');
  });

  it('American Conservative lands in Lean Right (post-April-2026 AllSides update)', () => {
    const ac = lookupOutlet('theamericanconservative.com');
    expect(ac?.lean).toBe('lean-right');
    expect(ac?.group).toBe('right');
  });

  it('Hot Air + Forbes + The Free Press are explicitly NOT on the allowlist', () => {
    expect(lookupOutlet('hotair.com')).toBeNull();
    expect(lookupOutlet('forbes.com')).toBeNull();
    expect(lookupOutlet('thefp.com')).toBeNull();
  });
});

describe('leanToGroup — AllSides v9 → 3-group collapse', () => {
  it('maps lean values per operator spec', () => {
    expect(leanToGroup('left')).toBe('left');
    expect(leanToGroup('lean-left')).toBe('left');
    expect(leanToGroup('center')).toBe('center');
    expect(leanToGroup('lean-right')).toBe('right');
    expect(leanToGroup('right')).toBe('right');
  });
});

describe('lookupOutlet — host-suffix match', () => {
  it('resolves exact-match hosts case-insensitively', () => {
    expect(lookupOutlet('cnn.com')?.domain).toBe('cnn.com');
    expect(lookupOutlet('CNN.COM')?.domain).toBe('cnn.com');
  });

  it('strips a leading www. label', () => {
    expect(lookupOutlet('www.nytimes.com')?.domain).toBe('nytimes.com');
  });

  it('resolves subdomain hosts via suffix match', () => {
    expect(lookupOutlet('edition.cnn.com')?.domain).toBe('cnn.com');
    expect(lookupOutlet('money.cnn.com')?.domain).toBe('cnn.com');
  });

  it('does NOT confuse boundary-adjacent lookalikes (mock-cnn.com)', () => {
    expect(lookupOutlet('mock-cnn.com')).toBeNull();
  });

  it('returns null for unknown hosts', () => {
    expect(lookupOutlet('example.org')).toBeNull();
    expect(lookupOutlet('news.random.co')).toBeNull();
  });
});

describe('isExcludedPath — opinion / editorial / contributor path guard', () => {
  const nyt = lookupOutlet('nytimes.com')!;
  const wsj = lookupOutlet('wsj.com')!;
  const guardian = lookupOutlet('theguardian.com')!;
  const propublica = lookupOutlet('propublica.org')!;

  it('matches an exact prefix path', () => {
    expect(isExcludedPath(nyt, 'https://www.nytimes.com/opinion/column.html')).toBe(true);
    expect(isExcludedPath(nyt, 'https://www.nytimes.com/live/opinion/live-blog')).toBe(true);
  });

  it('does NOT match a news URL on the same outlet', () => {
    expect(isExcludedPath(nyt, 'https://www.nytimes.com/2026/us/politics/story')).toBe(false);
    expect(isExcludedPath(wsj, 'https://www.wsj.com/articles/story-123')).toBe(false);
  });

  it("Guardian's /commentisfree/ excluded (named prefix)", () => {
    expect(isExcludedPath(guardian, 'https://www.theguardian.com/commentisfree/column')).toBe(true);
    expect(isExcludedPath(guardian, 'https://www.theguardian.com/us-news/story')).toBe(false);
  });

  it('empty exclude_prefixes list → always false', () => {
    expect(propublica.exclude_prefixes).toEqual([]);
    expect(isExcludedPath(propublica, 'https://www.propublica.org/anything')).toBe(false);
  });

  it('malformed URL → false (never allows a parse failure to open the gate)', () => {
    expect(isExcludedPath(nyt, 'not a url')).toBe(false);
  });
});

describe('PAYWALL_FREE_PREFERRED_HOSTS — preference order for lazy text fetch', () => {
  it('starts with AP + Reuters (wire-service invariant)', () => {
    expect(PAYWALL_FREE_PREFERRED_HOSTS[0]).toBe('apnews.com');
    expect(PAYWALL_FREE_PREFERRED_HOSTS[1]).toBe('reuters.com');
  });

  it('every preferred host is on the OUTLETS allowlist', () => {
    for (const host of PAYWALL_FREE_PREFERRED_HOSTS) {
      expect(lookupOutlet(host)).not.toBeNull();
    }
  });

  it('every preferred host is outlet_type news (never commentary)', () => {
    for (const host of PAYWALL_FREE_PREFERRED_HOSTS) {
      expect(lookupOutlet(host)?.type).toBe('news');
    }
  });
});
