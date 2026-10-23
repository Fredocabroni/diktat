// Source-pin tests for the "Continue with X" wiring on /login.
// vitest runs the apps/web suite in Node — React is not rendered —
// so these tests assert the structural invariants the operator
// contract depends on by reading the source as text.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const LOGIN = readFileSync(new URL('../login/page.tsx', import.meta.url), 'utf8');
const CALLBACK = readFileSync(new URL('../auth/callback/route.ts', import.meta.url), 'utf8');
const APP_LAYOUT = readFileSync(new URL('../(app)/layout.tsx', import.meta.url), 'utf8');

describe('/login — X OAuth button', () => {
  it("calls supabase.auth.signInWithOAuth with the OAuth 2.0 'x' provider literal", () => {
    // Hosted Supabase has "X / Twitter (OAuth 2.0)" enabled — the
    // provider literal is 'x', not the OAuth 1.0a 'twitter'. The
    // supabase-js 2.103.3 Provider union doesn't list 'x' yet, so
    // the call site casts; the SDK forwards the string into the auth
    // URL verbatim, so the literal is what counts at runtime.
    expect(LOGIN).toMatch(/signInWithOAuth\(\{[\s\S]{0,300}provider:\s*'x'\s+as\s+Provider/);
  });

  it('imports the Provider type from supabase-js for the explicit cast', () => {
    // Guards against the cast being deleted and the literal silently
    // reverting under a stricter future TS config.
    expect(LOGIN).toMatch(/import type \{ AuthError, Provider \} from '@supabase\/supabase-js'/);
  });

  it('redirects back to /auth/callback on the current origin', () => {
    expect(LOGIN).toMatch(/redirectTo:\s*`\$\{window\.location\.origin\}\/auth\/callback`/);
  });

  it('is wired via onClick to the signInWithX handler, not inline logic', () => {
    expect(LOGIN).toMatch(/onClick=\{signInWithX\}/);
    expect(LOGIN).toMatch(/async function signInWithX\(\)/);
  });

  it('stays disabled unless NEXT_PUBLIC_X_OAUTH_ENABLED is true', () => {
    expect(LOGIN).toMatch(/xOauthEnabled\s*=\s*clientEnv\.X_OAUTH_ENABLED/);
    expect(LOGIN).toMatch(
      /disabled=\{!xOauthEnabled \|\| busy \|\| !xCaptchaReady \|\| geoBlocked\}/,
    );
  });

  it('still shows the "X sign-in is not available yet." affordance when disabled', () => {
    // Pre-existing copy, preserved by this PR.
    expect(LOGIN).toMatch(/X sign-in is not available yet\./);
    expect(LOGIN).toMatch(/\{!xOauthEnabled &&[\s\S]{0,200}X sign-in is not available yet/);
  });
});

describe('/login — Turnstile on the X OAuth path', () => {
  it('mounts a SECOND TurnstileWidget above the X button when the site key is set', () => {
    // The widget appears both inside the email form (action
    // "login_otp_request") and in the X section (action
    // "login_x_oauth") — two distinct challenge instances with
    // different action tags for Turnstile analytics.
    const widgetCount = (LOGIN.match(/<TurnstileWidget/g) ?? []).length;
    expect(widgetCount).toBeGreaterThanOrEqual(2);
    expect(LOGIN).toMatch(/action="login_x_oauth"/);
  });

  it('gates the X widget mount on BOTH xOauthEnabled AND captchaRequired', () => {
    // Hidden entirely when X OAuth is off (no reason to challenge a
    // disabled button) AND when the Turnstile site key is unset
    // (byte-identical to pre-Turnstile X behaviour).
    expect(LOGIN).toMatch(/\{xOauthEnabled && captchaRequired &&[\s\S]{0,120}<TurnstileWidget/);
  });

  it('uses a SEPARATE token state from the email-OTP flow', () => {
    // Mixing tokens across different action-tagged flows would defeat
    // the Turnstile `action` scoping and break if either path
    // consumed the token before the other.
    expect(LOGIN).toMatch(/\[xCaptchaToken,\s*setXCaptchaToken\]/);
    expect(LOGIN).toMatch(/xCaptchaReady\s*=\s*!captchaRequired\s*\|\|\s*xCaptchaToken !== null/);
    expect(LOGIN).toMatch(/clearXCaptchaToken\s*=\s*useCallback/);
  });

  it('passes expired-callback and error-callback that null the X token (auto-retry inside the widget)', () => {
    expect(LOGIN).toMatch(/onExpired=\{clearXCaptchaToken\}/);
    expect(LOGIN).toMatch(/onError=\{clearXCaptchaToken\}/);
  });

  it('drops the X token after invoking signInWithOAuth (one token = one attempt)', () => {
    const handlerStart = LOGIN.indexOf('async function signInWithX');
    const handlerEnd = LOGIN.indexOf('async function verifyCode');
    const handlerBlock = LOGIN.slice(handlerStart, handlerEnd);
    expect(handlerBlock).toMatch(/setXCaptchaToken\(null\)/);
  });

  it('does NOT thread the X Turnstile token into Supabase (friction-only)', () => {
    // signInWithOAuth does not accept `captchaToken` server-side —
    // the OAuth surface has no CAPTCHA hook on Supabase. Passing it
    // would be a no-op; omitting it is the correct shape.
    const handlerStart = LOGIN.indexOf('async function signInWithX');
    const handlerEnd = LOGIN.indexOf('async function verifyCode');
    const handlerBlock = LOGIN.slice(handlerStart, handlerEnd);
    expect(handlerBlock).not.toMatch(/captchaToken/);
    expect(handlerBlock).not.toMatch(/xCaptchaToken[^.]/); // allow in state refs outside
  });
});

describe('/login — X OAuth error posture', () => {
  it('surfaces an error through describeOtpError, not a raw message', () => {
    // Reuses the existing OTP error-mapping so rate-limit / invalid-
    // email signals share one copy register with the email flow.
    const handlerStart = LOGIN.indexOf('async function signInWithX');
    const handlerEnd = LOGIN.indexOf('async function verifyCode');
    const handlerBlock = LOGIN.slice(handlerStart, handlerEnd);
    expect(handlerBlock).toMatch(/setError\(describeOtpError\(error\)\)/);
  });

  it('releases the busy flag on the error branch so the button re-enables', () => {
    const handlerStart = LOGIN.indexOf('async function signInWithX');
    const handlerEnd = LOGIN.indexOf('async function verifyCode');
    const handlerBlock = LOGIN.slice(handlerStart, handlerEnd);
    expect(handlerBlock).toMatch(/setBusy\(false\)/);
  });
});

describe('X signups without an email address are handled end-to-end', () => {
  // X may return a user record with no email. Nothing in the signup
  // pipeline reads `data.user.email`:
  //   - /auth/callback only calls exchangeCodeForSession(code).
  //   - handle_new_user (migration 0009) generates the public.users
  //     handle from the UUID, not from email.
  //   - The (app) layout's fail-closed copy was reworded to not
  //     assume the user has an email.
  // These source-pin tests guard against any of those surfaces
  // regressing into an email dependency.

  it('/auth/callback does not read data.user.email', () => {
    expect(CALLBACK).not.toMatch(/\.email\b/);
    expect(CALLBACK).not.toMatch(/data\.user/);
  });

  it('/auth/callback is a pure exchange-and-redirect — no email branch', () => {
    expect(CALLBACK).toMatch(/exchangeCodeForSession\(code\)/);
    // The error branch bounces to /login with a generic flag, not an
    // email-specific one.
    expect(CALLBACK).toMatch(/\/login\?error=exchange_failed/);
  });

  it('/login does not read supabase user.email on the OAuth path', () => {
    const handlerStart = LOGIN.indexOf('async function signInWithX');
    const handlerEnd = LOGIN.indexOf('async function verifyCode');
    const handlerBlock = LOGIN.slice(handlerStart, handlerEnd);
    // The only `.email` the OAuth path touches is the describeOtpError
    // msg-text check, which runs on the Supabase error, not on the user.
    expect(handlerBlock).not.toMatch(/user\.email|data\.user/);
  });

  it('(app)/layout fail-closed copy does NOT assume the user has an email', () => {
    // Pre-fix read: "with your account email". Post-fix accepts both
    // email-signup and X-signup users.
    expect(APP_LAYOUT).not.toMatch(/your account email/);
    expect(APP_LAYOUT).toMatch(/sign-in method \(email or X account\)/);
  });
});
