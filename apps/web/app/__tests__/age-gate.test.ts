// Source-pin tests for the 18+ age gate (migration 20261108000000).
// vitest runs the apps/web suite in Node — React is not rendered —
// so these tests assert the structural invariants the gate relies on
// by reading the source as text. Mirrors the pattern used by
// drop-card-selected.test.ts and session-length-nudge.test.ts.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const LAYOUT = readFileSync(new URL('../(app)/layout.tsx', import.meta.url), 'utf8');
const AGE_PAGE = readFileSync(new URL('../onboard/age/page.tsx', import.meta.url), 'utf8');
const NOT_ELIGIBLE = readFileSync(new URL('../not-eligible/page.tsx', import.meta.url), 'utf8');
const LOGIN = readFileSync(new URL('../login/page.tsx', import.meta.url), 'utf8');

describe('(app) layout — age-gate redirect order', () => {
  it('reads age_verified_at + age_blocked_at from get_user_self()', () => {
    expect(LAYOUT).toMatch(/age_verified_at: string \| null;?\s*\n?\s*age_blocked_at:/);
  });

  it('redirects a blocked account to /not-eligible BEFORE anything else', () => {
    // Order matters: blocked check must come before unverified so a
    // terminal-blocked account cannot slip past the one-way redirect.
    const blockedIdx = LAYOUT.indexOf("redirect('/not-eligible')");
    const unverifiedIdx = LAYOUT.indexOf("redirect('/onboard/age')");
    const onboardIdx = LAYOUT.indexOf("redirect('/onboard/welcome')");
    expect(blockedIdx).toBeGreaterThan(0);
    expect(unverifiedIdx).toBeGreaterThan(blockedIdx);
    expect(onboardIdx).toBeGreaterThan(unverifiedIdx);
  });

  it('age-gate redirects fire BEFORE the (app) shell renders', () => {
    // Both redirects must appear before the final `return (<> …` of the
    // layout component — else the shell renders first and the gate
    // becomes advisory.
    const shellReturn = LAYOUT.indexOf('<main className="min-h-dvh');
    const blockedIdx = LAYOUT.indexOf("redirect('/not-eligible')");
    const unverifiedIdx = LAYOUT.indexOf("redirect('/onboard/age')");
    expect(blockedIdx).toBeLessThan(shellReturn);
    expect(unverifiedIdx).toBeLessThan(shellReturn);
  });
});

describe('/onboard/age — self-attestation page', () => {
  it('calls trpc.user.attestAge with the entered birthDate', () => {
    expect(AGE_PAGE).toMatch(/trpc\.user\.attestAge\.useMutation/);
    expect(AGE_PAGE).toMatch(/attest\.mutate\(\{\s*birthDate\s*\}\s*\)/);
  });

  it('routes to /not-eligible on a blocked outcome, to / otherwise', () => {
    expect(AGE_PAGE).toMatch(/outcome\.outcome === 'blocked'/);
    expect(AGE_PAGE).toMatch(/router\.push\('\/not-eligible'\)/);
    expect(AGE_PAGE).toMatch(/router\.push\('\/'\)/);
  });

  it('carries copy that discloses: DOB is NOT stored', () => {
    // Operator contract: data minimisation. The page must tell the
    // user the server reads the DOB and drops it; the DB migration
    // never stores it. HTML entity (&rsquo;) in the JSX counts.
    expect(AGE_PAGE).toMatch(/don(?:'|&rsquo;)t store your date of birth/i);
  });

  it('carries no hints about lying / coaching the "right" answer', () => {
    // Word-bounded patterns so unrelated substrings in prose (e.g.
    // "implies") don't trip the pin. The forbidden shape would appear
    // in a dark-pattern "psst, pick 2000 if you want in" page.
    const forbiddenPatterns: RegExp[] = [
      /\blie\b/i,
      /\bfake\b/i,
      /\bpretend\b/i,
      /if you(?:'|&rsquo;)?re under 18/i,
      /pick a date before/i,
      /say you(?:'|&rsquo;)?re 18/i,
    ];
    for (const bad of forbiddenPatterns) {
      expect(AGE_PAGE).not.toMatch(bad);
    }
  });
});

describe('/not-eligible — terminal state page', () => {
  it('offers a sign-out button and nothing else', () => {
    expect(NOT_ELIGIBLE).toMatch(/supabase\.auth\.signOut/);
    expect(NOT_ELIGIBLE).toMatch(/Sign out/);
  });

  it('is plain and respectful — no shame, no next-steps bait', () => {
    const forbidden = [
      'try again later',
      'come back',
      'tomorrow',
      'that.?s a shame',
      'unfortunately',
      'try different',
      'sorry',
    ];
    for (const bad of forbidden) {
      expect(NOT_ELIGIBLE.toLowerCase()).not.toMatch(new RegExp(bad.toLowerCase()));
    }
  });

  it('states the 18+ rule plainly in the headline', () => {
    expect(NOT_ELIGIBLE).toMatch(/Diktat is for adults 18\+/);
  });
});

describe('/login — 18+ notice', () => {
  it('shows "18+ only" copy on the signup / signin screen', () => {
    expect(LOGIN).toMatch(/18\+\s*only/);
  });
});
