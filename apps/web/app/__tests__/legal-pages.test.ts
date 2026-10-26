// Source-pin tests for /terms + /privacy. The compliance posture is
// load-bearing: an un-noticed edit that softens the "no sale of data"
// or "AP has no cash value" clause must fail CI, not quietly ship.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const TERMS = readFileSync(new URL('../terms/page.tsx', import.meta.url), 'utf8');
const PRIVACY = readFileSync(new URL('../privacy/page.tsx', import.meta.url), 'utf8');
const LOGIN = readFileSync(new URL('../login/page.tsx', import.meta.url), 'utf8');
const SETTINGS = readFileSync(
  new URL('../(app)/settings/notifications/page.tsx', import.meta.url),
  'utf8',
);

describe('/terms + /privacy — meta', () => {
  it('both pages carry a Last-updated date', () => {
    expect(TERMS).toMatch(/const LAST_UPDATED = '20\d{2}-\d{2}-\d{2}'/);
    expect(PRIVACY).toMatch(/const LAST_UPDATED = '20\d{2}-\d{2}-\d{2}'/);
  });

  it('both pages render as server components (no "use client")', () => {
    expect(TERMS).not.toMatch(/^'use client'/m);
    expect(PRIVACY).not.toMatch(/^'use client'/m);
  });

  it('both pages reference the operator-provided support address', () => {
    // Swapped from CONTACT_EMAIL_PLACEHOLDER on push 3 (2026-10-22).
    expect(TERMS).toMatch(/'support@diktat\.app'/);
    expect(PRIVACY).toMatch(/'support@diktat\.app'/);
    // Negative-space guard: neither page may ship with the placeholder.
    expect(TERMS).not.toMatch(/CONTACT_EMAIL_PLACEHOLDER/);
    expect(PRIVACY).not.toMatch(/CONTACT_EMAIL_PLACEHOLDER/);
  });

  it('both pages set a <title> via Next metadata export', () => {
    expect(TERMS).toMatch(/export const metadata: Metadata/);
    expect(PRIVACY).toMatch(/export const metadata: Metadata/);
  });
});

describe('/terms — load-bearing clauses', () => {
  it('names the US-only + 18+ eligibility bar', () => {
    expect(TERMS).toMatch(/residents of the United States who are 18 or older/);
  });

  it('states the DOB-never-stored invariant', () => {
    expect(TERMS).toMatch(/discard the date[\s\S]{0,40}right after the check/);
  });

  it('states Arena Points have no cash value and cannot be traded', () => {
    expect(TERMS).toMatch(/Arena Points[\s\S]*?have no cash value/);
    expect(TERMS).toMatch(/cannot buy, sell,[\s\S]{0,40}trade, or redeem/);
  });

  it('states no wallets, no tokens, no real-money features', () => {
    expect(TERMS).toMatch(/no wallets, no tokens, and no real-money features/);
  });

  it('names a DMCA contact pathway', () => {
    expect(TERMS).toMatch(/DMCA/);
    // Formatter wraps "17" to a line of its own with ~12 chars of
    // indent before "U.S.C.".
    expect(TERMS).toMatch(/17[\s\S]{0,40}U\.S\.C\.[\s\S]{0,10}§512\(c\)\(3\)/);
  });

  it('names the content-reporting pathway', () => {
    expect(TERMS).toMatch(/report a post from inside the app/);
  });
});

describe('/privacy — collection list', () => {
  it('names Email, X profile basics, handle, activity, age-check timestamp, security logs, Turnstile', () => {
    expect(PRIVACY).toMatch(/Email address/);
    expect(PRIVACY).toMatch(/X profile basics/);
    expect(PRIVACY).toMatch(/Your Diktat handle/);
    expect(PRIVACY).toMatch(/Your activity/);
    expect(PRIVACY).toMatch(/Age-check timestamp/);
    expect(PRIVACY).toMatch(/security and usage logs/);
    expect(PRIVACY).toMatch(/Bot-check token/);
  });

  it('explicitly denies storing the raw date of birth', () => {
    expect(PRIVACY).toMatch(/never store the date of birth/);
  });

  it('explicitly denies reading X DMs or follower list', () => {
    expect(PRIVACY).toMatch(/do not read your DMs or your[\s\S]{0,20}follower list/);
  });
});

describe('/privacy — processor list (must match reality)', () => {
  // Every processor named here appears in CLAUDE.md's architecture or
  // TODOs. Adding a new processor to Diktat MUST land here in the same
  // PR as the code change.
  it('lists exactly the current processors', () => {
    for (const name of [
      'Supabase',
      'Vercel',
      'Railway',
      'Resend',
      'Cloudflare Turnstile',
      'Upstash',
      'Telegram',
      'X / Twitter',
      'Anthropic',
      'Perplexity',
      'xAI',
    ]) {
      expect(PRIVACY).toMatch(new RegExp(name));
    }
  });

  it('Telegram processor entry names the report-alert boundary (reason text not sent)', () => {
    expect(PRIVACY).toMatch(
      /Telegram[\s\S]{0,80}operator alerts when you[\s\S]{0,40}report a post/,
    );
    expect(PRIVACY).toMatch(/not your reason text/);
  });
});

describe('/privacy — negative-space commitments', () => {
  it("says 'We do not sell your personal data'", () => {
    expect(PRIVACY).toMatch(/We do not sell your personal data/);
  });

  it("says 'We do not run targeted ads'", () => {
    expect(PRIVACY).toMatch(/We do not run targeted ads/);
  });

  it("says 'We do not offer wallets, tokens, or any real-money features'", () => {
    expect(PRIVACY).toMatch(/do not offer wallets, tokens, or any real-money features/);
  });
});

describe('/privacy — rights block', () => {
  it('names the self-serve delete pathway in Settings', () => {
    // Formatter wraps the clause and JSX turns the quotes into &ldquo;/&rdquo;.
    expect(PRIVACY).toMatch(/Settings has a[\s\S]{0,30}self-serve[\s\S]{0,80}Delete my account/);
  });

  it('names access + correction + deletion', () => {
    expect(PRIVACY).toMatch(/See your data/);
    expect(PRIVACY).toMatch(/Correct your data/);
    expect(PRIVACY).toMatch(/Delete your account/);
  });
});

describe('/privacy — retention', () => {
  // 7-day age-blocked purge claim removed on push 3 — PR #289's
  // minimization sweep is not merged yet, so the policy is reworded
  // as "may retain a minimal record to enforce the age requirement."
  it('does not claim an age-block purge window the DB does not yet enforce', () => {
    expect(PRIVACY).not.toMatch(/purged within 7 days/);
    expect(PRIVACY).toMatch(
      /under 18 at the age check[\s\S]{0,80}minimal record to[\s\S]{0,30}enforce the age requirement/,
    );
  });

  it('names the 30-day short-log rotation', () => {
    expect(PRIVACY).toMatch(/security logs rotate within 30 days/);
  });

  it('states ledger-amount retention + user-ID removal including from transaction keys', () => {
    // Mirrors #288 behaviour exactly: ledger amounts preserved,
    // user_id anonymized, idempotency_key UUID scrubbed on delete.
    expect(PRIVACY).toMatch(
      /Arena Points ledger[\s\S]{0,40}amounts[\s\S]{0,20}are kept[\s\S]{0,120}user ID is removed, including[\s\S]{0,30}from[\s\S]{0,20}transaction keys/,
    );
  });
});

describe('Legal links are reachable from login + settings', () => {
  it('/login footer links to /terms AND /privacy', () => {
    // Formatter may split the href onto its own line.
    expect(LOGIN).toMatch(/<Link[\s\S]{0,80}href="\/terms"/);
    expect(LOGIN).toMatch(/<Link[\s\S]{0,80}href="\/privacy"/);
  });

  it('settings notifications page links to /terms AND /privacy', () => {
    expect(SETTINGS).toMatch(/href="\/terms"/);
    expect(SETTINGS).toMatch(/href="\/privacy"/);
  });
});
