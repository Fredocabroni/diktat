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
      // 'news' admitted by migration 20261016000000 (S1+S3 reputable-tier).
      'news',
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

describe('classifyUrl — MSM ban-list (post-S1+S3)', () => {
  it('classifies still-banned hosts as framing (NEVER primary)', () => {
    // Hosts that remain on MSM_BAN_LIST after the S1+S3 reconciliation:
    // either MBFC-mixed, operator-rejected, or opinion-first with no
    // factual-rating floor pass.
    for (const host of [
      'foxnews.com',
      'msnbc.com',
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
    expect(classifyUrl('https://blog.foxnews.com/politics/x')).toMatchObject({
      allowed: false,
      role: 'framing',
      host: 'blog.foxnews.com',
    });
    expect(classifyUrl('https://local.msnbc.com/markets').role).toBe('framing');
  });

  it('does NOT confuse mock-foxnews.com with foxnews.com (suffix boundary defense)', () => {
    expect(classifyUrl('https://mock-foxnews.com/x')).toMatchObject({
      allowed: false,
      role: 'rejected',
    });
  });

  it('covers every still-banned host', () => {
    // The S1+S3 reconciliation REMOVED cnn.com, nytimes.com,
    // washingtonpost.com, wsj.com from MSM_BAN_LIST — they are now
    // reputable-tier (packages/shared/src/news-outlets.ts).
    expect(MSM_BAN_LIST).not.toContain('cnn.com');
    expect(MSM_BAN_LIST).not.toContain('nytimes.com');
    expect(MSM_BAN_LIST).not.toContain('washingtonpost.com');
    expect(MSM_BAN_LIST).not.toContain('wsj.com');
    expect(MSM_BAN_LIST).toContain('foxnews.com');
    expect(MSM_BAN_LIST).toContain('msnbc.com');
    expect(MSM_BAN_LIST).toContain('huffpost.com');
    expect(MSM_BAN_LIST).toContain('dailywire.com');
    expect(MSM_BAN_LIST).toContain('breitbart.com');
    expect(MSM_BAN_LIST).toContain('jacobin.com');
  });
});

describe('classifyUrl — S1+S3 reputable tier', () => {
  it('classifies CNN as reputable with lean-left / left-group / news-type', () => {
    expect(classifyUrl('https://www.cnn.com/politics/x')).toMatchObject({
      allowed: true,
      role: 'reputable',
      evidence_tier: 'reputable',
      category: 'news',
      outlet_lean: 'lean-left',
      outlet_group: 'left',
      outlet_type: 'news',
      host: 'cnn.com',
    });
  });

  it('classifies NYT news URL as reputable; NYT /opinion/ URL as rejected', () => {
    expect(classifyUrl('https://www.nytimes.com/2026/us/politics/story').role).toBe('reputable');
    expect(classifyUrl('https://www.nytimes.com/opinion/column.html')).toMatchObject({
      allowed: false,
      role: 'rejected',
    });
  });

  it('classifies WSJ news URL as reputable with lean-right / right-group', () => {
    expect(classifyUrl('https://www.wsj.com/articles/story-123')).toMatchObject({
      allowed: true,
      role: 'reputable',
      outlet_lean: 'lean-right',
      outlet_group: 'right',
    });
  });

  it('classifies AP + Reuters as reputable (Center group — paywall-free preferred)', () => {
    expect(classifyUrl('https://apnews.com/article/story')).toMatchObject({
      allowed: true,
      role: 'reputable',
      outlet_lean: 'center',
      outlet_group: 'center',
      outlet_type: 'news',
    });
    expect(classifyUrl('https://www.reuters.com/world/story')).toMatchObject({
      allowed: true,
      role: 'reputable',
      outlet_lean: 'center',
      outlet_group: 'center',
    });
    // Reuters /commentary/ is excluded.
    expect(classifyUrl('https://www.reuters.com/commentary/column').role).toBe('rejected');
  });

  it('classifies Mother Jones / National Review as reputable commentary (never evidence)', () => {
    expect(classifyUrl('https://www.motherjones.com/politics/story')).toMatchObject({
      allowed: true,
      role: 'reputable',
      outlet_type: 'commentary',
      outlet_group: 'left',
    });
    expect(classifyUrl('https://www.nationalreview.com/corner/story')).toMatchObject({
      allowed: true,
      role: 'reputable',
      outlet_type: 'commentary',
      outlet_group: 'right',
    });
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

  it('rejects truly-unknown-host URLs (not on primary, not reputable, not banned)', () => {
    // AP / Reuters / Bloomberg are now REPUTABLE under S1+S3; the strict
    // "V1 primary-source only" posture was replaced by tier+balance.
    // Use genuinely-unknown hosts to assert the rejected branch.
    for (const host of ['example.org', 'news.random.co', 'blog.unknown-site.net']) {
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
