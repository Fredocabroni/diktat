// Source-level pins for the onboarding "look around first" off-ramp.
// vitest-node; no React rendering. The invariants this test keeps
// green are: un-onboarded user can reach /peek, /peek renders the
// DropCard in read-only mode, the welcome page offers a Look around
// first link to /peek, and the age / sign-in gates still apply.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const PAGE = readFileSync(new URL('../peek/page.tsx', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../peek/PeekClient.tsx', import.meta.url), 'utf8');
const WELCOME = readFileSync(new URL('../onboard/welcome/page.tsx', import.meta.url), 'utf8');

describe('/peek — auth and age gates, no onboarding gate', () => {
  it('redirects to /login when there is no signed-in user', () => {
    expect(PAGE).toMatch(/if \(!user\) redirect\('\/login'\)/);
  });
  it('age gates still apply: blocked → /not-eligible, unverified → /onboard/age', () => {
    expect(PAGE).toMatch(/if \(profile\.age_blocked_at\) redirect\('\/not-eligible'\)/);
    expect(PAGE).toMatch(/if \(!profile\.age_verified_at\) redirect\('\/onboard\/age'\)/);
  });
  it('does NOT redirect un-onboarded users to /onboard/welcome', () => {
    // Positive: the page is the pre-onboarding preview, it must not
    // bounce on onboarded_at === null.
    expect(PAGE).not.toMatch(/if \(!profile\.onboarded_at\) redirect\('\/onboard\/welcome'\)/);
    // It does send an already-onboarded user to Home so /peek stays
    // strictly pre-onboarding.
    expect(PAGE).toMatch(/if \(profile\.onboarded_at\) redirect\('\/'\)/);
  });
});

describe('/peek client — read-only Drop + tribe CTA', () => {
  it('renders DropCard with readOnly and no vote callback behaviour', () => {
    expect(CLIENT).toMatch(/<DropCard[\s\S]*?readOnly/);
    // onStance is still required by the DropCard contract but is a no-op.
    expect(CLIENT).toMatch(/onStance=\{\(\) => \{[\s\S]*?\/\* read-only \*\//);
  });
  it('exposes a tribe CTA pointing at /onboard/tribe', () => {
    expect(CLIENT).toMatch(/data-component="PeekClient\.TribeCta"/);
    expect(CLIENT).toMatch(/href="\/onboard\/tribe"/);
    expect(CLIENT).toContain('pick a tribe to join in');
  });
  it('fetches feed.list via tRPC (no custom endpoint needed)', () => {
    expect(CLIENT).toMatch(/trpc\.feed\.list\.useQuery\(\)/);
  });
  it('does NOT mount the CommentsPanel on peek (no commenting pre-tribe)', () => {
    expect(CLIENT).not.toMatch(/CommentsPanel/);
  });
  it('refuses engagement anti-patterns on the peek surface', () => {
    // Scope to the JSX return bodies — the file legitimately uses
    // `readOnly` as a prop name, so "Only" cannot be a free-text
    // forbidden token.
    const bodyStart = CLIENT.indexOf("'use client'");
    expect(bodyStart).toBeGreaterThan(-1);
    const body = CLIENT.slice(bodyStart);
    for (const bad of ['confetti', '🎉', '🔥', '🏆', 'trending', 'HOT']) {
      expect(body).not.toContain(bad);
    }
  });
});

describe('/onboard/welcome — "look around first" link', () => {
  it('surfaces a link to /peek on the welcome screen', () => {
    expect(WELCOME).toMatch(/data-component="OnboardWelcome\.PeekLink"/);
    expect(WELCOME).toMatch(/href="\/peek"/);
    expect(WELCOME).toContain('look around first');
  });
});
