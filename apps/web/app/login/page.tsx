// Email OTP + (disabled) X OAuth. One-screen sign-in. No countdowns, no
// dark-pattern "get started" modals — the user types their email, asks
// for a code, pastes it back. That's it.
//
// Copy is civic and plain per the brand voice guide.

'use client';

import type { AuthError } from '@supabase/supabase-js';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';

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
};

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(callbackError);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
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
      },
    });
    setBusy(false);
    if (error) {
      setError(describeOtpError(error));
      return;
    }
    setStep('code');
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getBrowserSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
    setBusy(false);
    if (error) {
      setError('That code did not match. Request a new one if it has expired.');
      return;
    }
    window.location.href = '/';
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <h1 className="font-display text-3xl font-bold">Welcome to the arena.</h1>
      <p className="mt-2 text-text-secondary">Sign in with your email to continue.</p>

      {step === 'email' && (
        <form onSubmit={requestCode} className="mt-8 flex flex-col gap-3">
          <label htmlFor="email" className="text-sm text-text-secondary">
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
            className="rounded-xl border border-white/10 bg-surface-elevated px-4 py-3 text-text-primary"
            placeholder="you@example.com"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-accent-primary px-4 py-3 font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={verifyCode} className="mt-8 flex flex-col gap-3">
          <label htmlFor="code" className="text-sm text-text-secondary">
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
            className="rounded-xl border border-white/10 bg-surface-elevated px-4 py-3 text-center font-mono text-2xl tracking-widest text-text-primary"
            placeholder="••••••"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-accent-primary px-4 py-3 font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button
            type="button"
            onClick={() => setStep('email')}
            className="text-sm text-text-secondary underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-accent-danger">{error}</p>}

      <div className="mt-10 border-t border-white/5 pt-6">
        <button
          type="button"
          disabled={!clientEnv.X_OAUTH_ENABLED}
          title={clientEnv.X_OAUTH_ENABLED ? undefined : 'X sign-in is not available yet.'}
          className="w-full rounded-full border border-white/10 px-4 py-3 text-sm font-semibold text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue with X
        </button>
        {!clientEnv.X_OAUTH_ENABLED && (
          <p className="mt-2 text-center text-xs text-text-tertiary">
            X sign-in is not available yet.
          </p>
        )}
      </div>
    </main>
  );
}
