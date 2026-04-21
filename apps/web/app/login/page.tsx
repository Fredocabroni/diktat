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
      setError('Code did not match. Request a new code to try again.');
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
          <button
            type="submit"
            disabled={busy}
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

      <div className="mt-10 border-t border-ink-300 pt-6">
        <button
          type="button"
          disabled={!clientEnv.X_OAUTH_ENABLED}
          className="w-full rounded-full border border-ink-400 px-4 py-3 text-sm font-semibold text-text-secondary transition hover:border-ink-500 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-400 disabled:hover:text-text-secondary"
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
