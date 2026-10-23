// Source-pin tests for the US-only pre-launch gate (migration
// 20261109000000 + /api/geo + /login + /auth/callback + /auth/confirm
// + /onboard/age). The invariants here are compliance-grade — a
// future edit that removes the geo check from any one of these
// surfaces fails CI, not production.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const GEO = readFileSync(new URL('../api/geo/route.ts', import.meta.url), 'utf8');
const LOGIN = readFileSync(new URL('../login/page.tsx', import.meta.url), 'utf8');
const CALLBACK = readFileSync(new URL('../auth/callback/route.ts', import.meta.url), 'utf8');
const CONFIRM = readFileSync(new URL('../auth/confirm/route.ts', import.meta.url), 'utf8');
const AGE_PAGE = readFileSync(new URL('../onboard/age/page.tsx', import.meta.url), 'utf8');

describe('/api/geo — Vercel country header', () => {
  it('reads x-vercel-ip-country from the server-side request headers', () => {
    expect(GEO).toMatch(/headers\(\)/);
    expect(GEO).toMatch(/x-vercel-ip-country/);
  });

  it('returns an empty string when the header is absent (local dev)', () => {
    expect(GEO).toMatch(/get\('x-vercel-ip-country'\)\s*\?\?\s*''/);
  });

  it('runs on the edge for low-latency country lookup', () => {
    expect(GEO).toMatch(/runtime = 'edge'/);
  });

  it('short-caches the response (one-check-per-session, no edge thrash)', () => {
    expect(GEO).toMatch(/Cache-Control.*private.*max-age=60/);
  });
});

describe('/login — client-side geo gate', () => {
  it('fetches /api/geo on mount', () => {
    expect(LOGIN).toMatch(/fetch\('\/api\/geo'/);
  });

  it("blocks on a non-US country but allows '' (unknown, local dev)", () => {
    // Guard against a regression that would block local-dev users
    // whose edge has no country tag.
    expect(LOGIN).toMatch(/c && c !== 'US' \? 'block' : 'allow'/);
  });

  it('disables the Send-code button when geoBlocked', () => {
    expect(LOGIN).toMatch(/disabled=\{busy \|\| !captchaReady \|\| geoBlocked\}/);
  });

  it('disables the Continue with X button when geoBlocked', () => {
    expect(LOGIN).toMatch(
      /disabled=\{!xOauthEnabled \|\| busy \|\| !xCaptchaReady \|\| geoBlocked\}/,
    );
  });

  it('shows the US-only notice copy when geoBlocked', () => {
    expect(LOGIN).toMatch(/Diktat is currently available in the US only\./);
    expect(LOGIN).toMatch(/\{geoBlocked && \(/);
    expect(LOGIN).toMatch(/\{US_ONLY_NOTICE\}/);
  });

  it('maps the ?error=not_us callback bounce to the same notice', () => {
    expect(LOGIN).toMatch(/not_us:\s*'Diktat is currently available in the US only\.'/);
  });

  it('refuses to call signInWithOtp when geoBlocked (defence-in-depth)', () => {
    // A crafted submit that removes the disabled attribute still
    // gets refused at the handler.
    const requestCodeIdx = LOGIN.indexOf('function requestCode');
    const next = LOGIN.indexOf('async function', requestCodeIdx + 10);
    const body = LOGIN.slice(requestCodeIdx, next);
    expect(body).toMatch(/if \(geoBlocked\)/);
  });

  it('refuses to call signInWithOAuth when geoBlocked (defence-in-depth)', () => {
    const signInIdx = LOGIN.indexOf('async function signInWithX');
    const next = LOGIN.indexOf('async function', signInIdx + 10);
    const body = LOGIN.slice(signInIdx, next);
    expect(body).toMatch(/if \(geoBlocked\)/);
  });
});

describe('/auth/callback — server-side geo gate (final enforcement)', () => {
  it('reads x-vercel-ip-country BEFORE exchangeCodeForSession', () => {
    const headerIdx = CALLBACK.indexOf("headers.get('x-vercel-ip-country')");
    const exchangeIdx = CALLBACK.indexOf('supabase.auth.exchangeCodeForSession(');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(exchangeIdx).toBeGreaterThan(headerIdx);
  });

  it('bounces non-US to /login?error=not_us without setting a session cookie', () => {
    expect(CALLBACK).toMatch(/country && country !== 'US'/);
    expect(CALLBACK).toMatch(/\/login\?error=not_us/);
  });

  it("allows empty country (local dev / lookup failure) — mirrors /login's posture", () => {
    // `country && country !== 'US'` short-circuits on empty.
    expect(CALLBACK).toMatch(/if \(country && country !== 'US'\) \{\s*return/);
  });
});

describe('/auth/confirm — magic-link path hits the same gate', () => {
  it('reads x-vercel-ip-country BEFORE the actual verifyOtp call', () => {
    // Match the header READ (not any mention of the string),
    // and the actual SDK call (not the "verifyOtp" word in a comment).
    const headerIdx = CONFIRM.indexOf("headers.get('x-vercel-ip-country')");
    const verifyIdx = CONFIRM.indexOf('supabase.auth.verifyOtp(');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(headerIdx);
  });

  it('bounces non-US to /login?error=not_us', () => {
    expect(CONFIRM).toMatch(/country && country !== 'US'/);
    expect(CONFIRM).toMatch(/\/login\?error=not_us/);
  });
});

describe('/onboard/age — US-resident checkbox', () => {
  it('tracks usResident state in the component', () => {
    expect(AGE_PAGE).toMatch(
      /\[usResident, setUsResident\] = useState<boolean>\(false\)|\[usResident, setUsResident\] = useState\(false\)/,
    );
  });

  it('renders a required US-resident checkbox', () => {
    expect(AGE_PAGE).toMatch(/type="checkbox"/);
    expect(AGE_PAGE).toMatch(/data-component="OnboardAgePage\.UsResident"/);
    expect(AGE_PAGE).toMatch(/I(?:'|&rsquo;)m a US resident\./);
  });

  it('threads usResident into the attestAge mutation call', () => {
    expect(AGE_PAGE).toMatch(/attest\.mutate\(\{ birthDate, usResident \}\)/);
  });

  it('refuses to submit the form when usResident is false', () => {
    expect(AGE_PAGE).toMatch(/if \(!usResident\)/);
  });
});
