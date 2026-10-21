// Source-pin tests for the Cloudflare Turnstile wiring on /login.
// vitest runs the apps/web suite in Node — React is not rendered —
// so these tests assert the structural invariants the operator
// contract depends on by reading the source as text.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const LOGIN = readFileSync(new URL('../login/page.tsx', import.meta.url), 'utf8');
const WIDGET = readFileSync(
  new URL('../../components/TurnstileWidget.tsx', import.meta.url),
  'utf8',
);
const ENV = readFileSync(new URL('../../lib/env.ts', import.meta.url), 'utf8');

describe('clientEnv.TURNSTILE_SITE_KEY — opt-in default', () => {
  it('exposes `TURNSTILE_SITE_KEY` with an empty-string default', () => {
    expect(ENV).toMatch(/TURNSTILE_SITE_KEY\(\)/);
    expect(ENV).toMatch(/process\.env\.NEXT_PUBLIC_TURNSTILE_SITE_KEY\s*\?\?\s*''/);
  });
});

describe('/login — Turnstile widget mount', () => {
  it('reads the site key from clientEnv.TURNSTILE_SITE_KEY', () => {
    expect(LOGIN).toMatch(/clientEnv\.TURNSTILE_SITE_KEY/);
  });

  it('mounts the widget only when the site key is non-empty (byte-identical pre-launch behaviour)', () => {
    // The `captchaRequired` boolean short-circuits the widget mount.
    // Empty site key → captchaRequired=false → the widget is NOT
    // rendered AND `options.captchaToken` is NOT passed to Supabase.
    expect(LOGIN).toMatch(/captchaRequired = turnstileSiteKey\.length > 0/);
    expect(LOGIN).toMatch(/\{captchaRequired &&[\s\S]{0,40}<TurnstileWidget/);
  });

  it('passes captchaToken to supabase.auth.signInWithOtp only when present', () => {
    // Supabase ignores `captchaToken: undefined`, but to keep the
    // call shape byte-identical with today pre-launch we omit the key
    // via spread when the token is null.
    expect(LOGIN).toMatch(/\.\.\.\(captchaToken \? \{ captchaToken \} : \{\}\)/);
  });

  it('passes captchaToken to supabase.auth.verifyOtp only when present', () => {
    expect(LOGIN).toMatch(/\.\.\.\(captchaToken \? \{ options: \{ captchaToken \} \} : \{\}\)/);
  });

  it('drops the token after each submission (success OR failure) so the widget renews', () => {
    // One token = one Supabase call. Not dropping would reuse an
    // expired token on the next attempt.
    const requestCodeIdx = LOGIN.indexOf('function requestCode');
    const verifyCodeIdx = LOGIN.indexOf('function verifyCode');
    const requestBlock = LOGIN.slice(requestCodeIdx, verifyCodeIdx);
    const verifyBlock = LOGIN.slice(verifyCodeIdx, verifyCodeIdx + 2000);
    expect(requestBlock).toMatch(/setCaptchaToken\(null\)/);
    expect(verifyBlock).toMatch(/setCaptchaToken\(null\)/);
  });

  it('disables the Send-code button until a token is present (when required)', () => {
    expect(LOGIN).toMatch(/disabled=\{busy \|\| !captchaReady\}/);
    expect(LOGIN).toMatch(/captchaReady = !captchaRequired \|\| captchaToken !== null/);
  });

  it('passes an action tag for Turnstile analytics / rule filtering', () => {
    expect(LOGIN).toMatch(/action="login_otp_request"/);
  });
});

describe('TurnstileWidget — behaviour contract', () => {
  it('loads the Turnstile SDK from challenges.cloudflare.com', () => {
    expect(WIDGET).toMatch(/https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  });

  it('calls expired-callback and error-callback to null the parent token', () => {
    // Operator contract: handle expired/failed tokens with retry.
    expect(WIDGET).toMatch(/'expired-callback'/);
    expect(WIDGET).toMatch(/'error-callback'/);
    expect(WIDGET).toMatch(/retry:\s*'auto'/);
  });

  it('is mobile-friendly: uses flexible sizing', () => {
    // `size: 'flexible'` scales to parent container, never overflows
    // a 320px viewport.
    expect(WIDGET).toMatch(/size:\s*'flexible'/);
  });

  it('is accessible: role="group" + aria-labelledby to a hidden label', () => {
    // Managed Turnstile widget sets its own aria; the parent region
    // gives screen-readers an addressable name beyond the raw iframe
    // title.
    expect(WIDGET).toMatch(/role="group"/);
    expect(WIDGET).toMatch(/aria-labelledby/);
    expect(WIDGET).toMatch(/Verify you(?:'|&rsquo;)re human/);
  });

  it('respects user color-scheme preference (theme: auto)', () => {
    expect(WIDGET).toMatch(/theme:\s*'auto'/);
  });

  it('cleans up the widget on unmount (dev strict-mode safety)', () => {
    expect(WIDGET).toMatch(/window\.turnstile\.remove\(widgetIdRef\.current\)/);
  });
});
