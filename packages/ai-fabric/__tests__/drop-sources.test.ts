import { describe, expect, it } from 'vitest';

import {
  MSM_BAN_LIST,
  PRIMARY_ALLOW_LIST,
  SOURCE_CATEGORIES,
  classifyUrl,
  normalizeHost,
} from '../src/prompts/drop-sources.js';

describe('SOURCE_CATEGORIES — eleven V1 buckets locked', () => {
  it('matches the schema-side CHECK constraint exactly', () => {
    // If this fails, the schema CHECK on news_topics_candidates.source_category
    // and this enum have drifted. Either is a load-bearing contract change
    // requiring a migration + this enum edit + an aligned PR.
    expect(SOURCE_CATEGORIES).toEqual([
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
    ]);
  });
});

describe('classifyUrl — PRIMARY allow-list', () => {
  it('allows congress.gov + subdomains as congress', () => {
    expect(classifyUrl('https://congress.gov/bill/118hr1234').allowed).toBe(true);
    expect(classifyUrl('https://www.congress.gov/bill/118hr1234')).toMatchObject({
      allowed: true,
      role: 'primary',
      category: 'congress',
      host: 'congress.gov',
    });
  });

  it('allows fred.stlouisfed.org under fed_economic', () => {
    expect(classifyUrl('https://fred.stlouisfed.org/series/UNRATE')).toMatchObject({
      allowed: true,
      role: 'primary',
      category: 'fed_economic',
    });
  });

  it('routes federalreserve.gov to fed_monetary, bls.gov to bls_labor', () => {
    const fed = classifyUrl(
      'https://federalreserve.gov/newsevents/pressreleases/monetary20260616a.htm',
    );
    expect(fed).toMatchObject({ allowed: true, role: 'primary', category: 'fed_monetary' });
    const bls = classifyUrl('https://www.bls.gov/news.release/empsit.htm');
    expect(bls).toMatchObject({ allowed: true, role: 'primary', category: 'bls_labor' });
  });

  it('routes supremecourt.gov under scotus_judicial', () => {
    expect(classifyUrl('https://www.supremecourt.gov/opinions/24pdf/22-1234.pdf')).toMatchObject({
      allowed: true,
      role: 'primary',
      category: 'scotus_judicial',
    });
  });

  it('routes sec.gov filings under sec_filings', () => {
    expect(classifyUrl('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany')).toMatchObject(
      { allowed: true, role: 'primary', category: 'sec_filings' },
    );
  });

  it('does NOT match notcongress.gov (suffix boundary defense)', () => {
    expect(classifyUrl('https://notcongress.gov/fake')).toMatchObject({
      allowed: false,
      role: 'rejected',
    });
  });
});

describe('classifyUrl — MSM ban-list', () => {
  it('classifies ban-listed hosts as framing (NEVER primary)', () => {
    for (const host of [
      'cnn.com',
      'foxnews.com',
      'msnbc.com',
      'nytimes.com',
      'washingtonpost.com',
      'wsj.com',
      'huffpost.com',
      'dailywire.com',
      'breitbart.com',
      'jacobin.com',
    ]) {
      const result = classifyUrl(`https://${host}/some/path`);
      expect(result.allowed).toBe(false);
      expect(result.role).toBe('framing');
    }
  });

  it('classifies subdomains of ban-listed hosts as framing', () => {
    expect(classifyUrl('https://edition.cnn.com/politics/x')).toMatchObject({
      allowed: false,
      role: 'framing',
      host: 'edition.cnn.com',
    });
    expect(classifyUrl('https://money.cnn.com/markets').role).toBe('framing');
  });

  it('does NOT confuse mock-cnn.com with cnn.com (suffix boundary defense)', () => {
    expect(classifyUrl('https://mock-cnn.com/x')).toMatchObject({
      allowed: false,
      role: 'rejected',
    });
  });

  it('covers every ban-listed host explicitly named in fact-check.ts', () => {
    // If a host is added to MSM_BAN_LIST without being on fact-check.ts's
    // NOT TRUTH SOURCES list (or vice versa), the contract drifted. This
    // is a structural check, not an integration test.
    expect(MSM_BAN_LIST).toContain('cnn.com');
    expect(MSM_BAN_LIST).toContain('foxnews.com');
    expect(MSM_BAN_LIST).toContain('msnbc.com');
    expect(MSM_BAN_LIST).toContain('nytimes.com');
    expect(MSM_BAN_LIST).toContain('washingtonpost.com');
    expect(MSM_BAN_LIST).toContain('wsj.com');
    expect(MSM_BAN_LIST).toContain('huffpost.com');
    expect(MSM_BAN_LIST).toContain('dailywire.com');
    expect(MSM_BAN_LIST).toContain('breitbart.com');
    expect(MSM_BAN_LIST).toContain('jacobin.com');
  });
});

describe('classifyUrl — rejection paths', () => {
  it('rejects http:// (TLS required)', () => {
    expect(classifyUrl('http://congress.gov/bill/123')).toMatchObject({
      allowed: false,
      role: 'rejected',
    });
  });

  it('rejects invalid URLs', () => {
    expect(classifyUrl('not a url')).toMatchObject({
      allowed: false,
      role: 'invalid',
      host: null,
    });
  });

  it('rejects neutral-host URLs (V1 strict primary-source posture)', () => {
    // AP, Reuters, Bloomberg are neutral wire services but NOT on the
    // V1 allow-list. The §1 contract is strict: only government primary
    // hosts. A future founder call could add a 'neutral' bucket.
    for (const host of ['apnews.com', 'reuters.com', 'bloomberg.com']) {
      expect(classifyUrl(`https://${host}/path`)).toMatchObject({
        allowed: false,
        role: 'rejected',
      });
    }
  });
});

describe('PRIMARY_ALLOW_LIST — every entry maps to a valid category', () => {
  it('every host pattern uses one of the eleven SOURCE_CATEGORIES', () => {
    for (const pat of PRIMARY_ALLOW_LIST) {
      expect(SOURCE_CATEGORIES).toContain(pat.category);
    }
  });
});

describe('normalizeHost', () => {
  it('lowercases', () => {
    expect(normalizeHost('Congress.GOV')).toBe('congress.gov');
  });

  it('strips a leading www.', () => {
    expect(normalizeHost('www.congress.gov')).toBe('congress.gov');
  });

  it('leaves other subdomains alone', () => {
    expect(normalizeHost('fred.stlouisfed.org')).toBe('fred.stlouisfed.org');
    expect(normalizeHost('edition.cnn.com')).toBe('edition.cnn.com');
  });
});
