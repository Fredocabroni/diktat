// Email OTP + (disabled) X OAuth. One-screen sign-in. No countdowns, no
// dark-pattern "get started" modals — the user types their email, asks
// for a code, pastes it back. That's it.
//
// Copy is civic and plain per the brand voice guide.

'use client';

import type { AuthError, Provider } from '@supabase/supabase-js';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { TurnstileWidget } from '../../components/TurnstileWidget';
import { clientEnv } from '../../lib/env';
import { getBrowserSupabaseClient } from '../../lib/supabase/browser';

type Step = 'email' | 'code' | 'sent';

const GENERIC_SEND_ERROR = 'Code not sent. Check the address and try again.';

// Map Supabase OTP failures to actionable copy. Only distinguish signals the
// user can act on (rate limit, malformed address). Anything that would hint
// at "we found an account but will not help you" collapses into the generic
// fallback to avoid an account-enumeration oracle.
function describeOtpError(err: AuthError): string {
  const msg = err.message?.toLowerCase() ?? '';
  if (err.status === 429 || msg.includes('rate limit')) {
    return 'Too many attempts. Wait 60 seconds and try again.';
  }
  if (msg.includes('invalid') && msg.includes('email')) {
    return 'That address is not valid. Check it and try again.';
  }
  return GENERIC_SEND_ERROR;
}

// Callback redirect errors (see apps/web/app/auth/callback/route.ts). Keep
// the copy generic — the callback already logged the specific cause.
const CALLBACK_ERRORS: Record<string, string> = {
  missing_code: 'Sign-in link was incomplete. Request a new code.',
  exchange_failed: 'Sign-in link expired or already used. Request a new code.',
  not_us: 'Diktat is currently available in the US only.',
};

const US_ONLY_NOTICE = 'Diktat is currently available in the US only.';

// Three states: unknown (initial / local dev / lookup failed), US (allow),
// non-US (block the form). The /api/geo route returns '' on unknown; the
// client treats '' as "allow — same as before this PR". Vercel's edge
// resolves country server-side so the client cannot forge it.
type GeoState = { kind: 'loading' } | { kind: 'allow' } | { kind: 'block' };

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const searchParams = useSearchParams();
  const callbackError = useMemo(() => {
    const code = searchParams.get('error');
    return code ? (CALLBACK_ERRORS[code] ?? GENERIC_SEND_ERROR) : null;
  }, [searchParams]);

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // Edge-side country check. We fetch `/api/geo` (reads
  // `x-vercel-ip-country` server-side) and block the form on non-US.
  // The /auth/callback route re-reads the header as the server-side
  // enforcement point for any client that bypassed this gate.
  const [geo, setGeo] = useState<GeoState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/geo', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { country: '' }))
      .then((j: { country?: string }) => {
        if (cancelled) return;
        const c = (j.country ?? '').toUpperCase();
        // Unknown / empty country → allow (local dev, geo-lookup
        // failure). The callback re-checks server-side so a
        // false-allow here still gets caught before session cookies
        // are set.
        setGeo({ kind: c && c !== 'US' ? 'block' : 'allow' });
      })
      .catch(() => {
        if (!cancelled) setGeo({ kind: 'allow' });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const geoBlocked = geo.kind === 'block';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(callbackError);
  // Cloudflare Turnstile — mounted only when the site key is set.
  // When empty, the widget is omitted and `options.captchaToken` is
  // never passed, which keeps today's behaviour byte-identical. Set
  // `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + flip the CAPTCHA toggle in the
  // Supabase dashboard once the web deploy ships (per PR description:
  // deploy web FIRST, then enable in Supabase).
  const turnstileSiteKey = clientEnv.TURNSTILE_SITE_KEY;
  const captchaRequired = turnstileSiteKey.length > 0;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaReady = !captchaRequired || captchaToken !== null;
  // Stable callback identity so TurnstileWidget's render-effect doesn't
  // tear down and re-mount the widget on every keystroke in the email
  // input. `setCaptchaToken` from useState is already stable; this makes
  // the clear-token path stable too.
  const clearCaptchaToken = useCallback(() => setCaptchaToken(null), []);
  // Separate Turnstile token for the X OAuth path. Supabase does NOT
  // verify this token server-side on `signInWithOAuth` (there is no
  // CAPTCHA hook for the OAuth surface) — it is a client-side bot-
  // friction gate only. The email-OTP token above is server-verified
  // by Supabase; mixing them would reuse a token across different
  // action-tagged flows and defeat the Turnstile `action` scoping.
  const [xCaptchaToken, setXCaptchaToken] = useState<string | null>(null);
  const xCaptchaReady = !captchaRequired || xCaptchaToken !== null;
  const clearXCaptchaToken = useCallback(() => setXCaptchaToken(null), []);
  const xOauthEnabled = clientEnv.X_OAUTH_ENABLED;

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    // Defence-in-depth: the button is disabled when geoBlocked, but a
    // crafted submit (e.g. devtools removing the disabled attribute)
    // still gets refused here. The /auth/callback route re-reads the
    // header server-side as the final enforcement point.
    if (geoBlocked) {
      setError(US_ONLY_NOTICE);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserSupabaseClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // shouldCreateUser keeps the signup path active — the trigger in
        // migration 0007 auto-provisions user, wallet, streak, and audit row.
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // Supabase ignores `captchaToken: undefined`, so omitting the
        // field pre-launch is byte-identical to the pre-Turnstile call.
        ...(captchaToken ? { captchaToken } : {}),
      },
    });
    setBusy(false);
    if (error) {
      setError(describeOtpError(error));
      // One token = one Supabase call. Drop the used/failed token so
      // the widget renews before the next attempt.
      setCaptchaToken(null);
      return;
    }
    setCaptchaToken(null);
    setStep('code');
  }

  async function signInWithX() {
    if (geoBlocked) {
      setError(US_ONLY_NOTICE);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserSupabaseClient();
    // The hosted Supabase project has the OAuth 2.0 "X / Twitter"
    // provider enabled, which is the `'x'` provider literal, NOT the
    // OAuth 1.0a `'twitter'` provider. supabase-js 2.103.3's `Provider`
    // union doesn't include `'x'` yet (added in a later minor), so
    // we cast — the SDK forwards the string straight into the auth
    // URL, so the literal is the only thing that matters at runtime.
    // When supabase-js bumps to a version that lists `'x'`, drop the
    // cast.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'x' as Provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    // On the happy path the browser is already navigating away to X.com
    // before this line runs. The clear + error branch only matters when
    // Supabase returns synchronously (e.g. provider disabled server-side).
    setXCaptchaToken(null);
    if (error) {
      setError(describeOtpError(error));
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getBrowserSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
      // Supabase's verifyOtp also accepts captchaToken when the
      // project has CAPTCHA enabled on the auth surface.
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });
    setBusy(false);
    if (error) {
      setError('Code did not match. Request a new code to try again.');
      setCaptchaToken(null);
      return;
    }
    window.location.href = '/';
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <h1 className="font-display text-4xl font-bold tracking-tight text-text-primary">
        Welcome to the arena.
      </h1>
      <p className="mt-3 text-text-secondary">
        Enter your email. We&rsquo;ll send a six-digit code.
      </p>
      <p className="mt-2 text-xs uppercase tracking-wide text-text-tertiary">18+ only.</p>

      {geoBlocked && (
        <p
          role="status"
          aria-live="polite"
          data-component="LoginPage.GeoBlocked"
          className="mt-6 rounded-xl border border-ink-300 bg-surface-card px-4 py-3 text-sm text-text-primary"
        >
          {US_ONLY_NOTICE}
        </p>
      )}

      {step === 'email' && (
        <form onSubmit={requestCode} className="mt-8 flex flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium text-text-secondary">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-xl border border-ink-500 bg-surface-card px-4 py-3 text-text-primary placeholder:text-text-tertiary focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40"
            placeholder="you@example.com"
          />
          {captchaRequired && (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              action="login_otp_request"
              onToken={setCaptchaToken}
              onExpired={clearCaptchaToken}
              onError={clearCaptchaToken}
            />
          )}
          <button
            type="submit"
            disabled={busy || !captchaReady || geoBlocked}
            className="mt-1 rounded-full bg-brand px-4 py-3 font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={verifyCode} className="mt-8 flex flex-col gap-3">
          <label htmlFor="code" className="text-sm font-medium text-text-secondary">
            Six-digit code
          </label>
          <input
            id="code"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="\d{6}"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded-xl border border-ink-500 bg-surface-card px-4 py-3 text-center font-mono text-2xl tracking-widest text-text-primary placeholder:text-text-tertiary focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40"
            placeholder="••••••"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-full bg-brand px-4 py-3 font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button
            type="button"
            onClick={() => setStep('email')}
            className="text-sm text-text-secondary underline-offset-4 hover:text-text-primary hover:underline"
          >
            Use a different email
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger-soft-fg">
          {error}
        </p>
      )}

      <div className="mt-10 flex flex-col gap-3 border-t border-ink-300 pt-6">
        {xOauthEnabled && captchaRequired && (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action="login_x_oauth"
            onToken={setXCaptchaToken}
            onExpired={clearXCaptchaToken}
            onError={clearXCaptchaToken}
          />
        )}
        <button
          type="button"
          onClick={signInWithX}
          disabled={!xOauthEnabled || busy || !xCaptchaReady || geoBlocked}
          className="w-full rounded-full border border-ink-400 px-4 py-3 text-sm font-semibold text-text-secondary transition hover:border-ink-500 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-400 disabled:hover:text-text-secondary"
        >
          Continue with X
        </button>
        {!xOauthEnabled && (
          <p className="text-center text-xs text-text-tertiary">X sign-in is not available yet.</p>
        )}
      </div>
    </main>
  );
}
