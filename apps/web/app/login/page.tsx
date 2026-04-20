// Email OTP + (disabled) X OAuth. One-screen sign-in. No countdowns, no
// dark-pattern "get started" modals — the user types their email, asks
// for a code, pastes it back. That's it.
//
// Copy is civic and plain per the brand voice guide.

'use client';

import { useState } from 'react';

import { clientEnv } from '../../lib/env';
import { getBrowserSupabaseClient } from '../../lib/supabase/browser';

type Step = 'email' | 'code' | 'sent';

export default function LoginPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getBrowserSupabaseClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(false);
    if (error) {
      setError('We could not send the code. Check the address and try again.');
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
          title={clientEnv.X_OAUTH_ENABLED ? undefined : 'X sign-in arrives soon.'}
          className="w-full rounded-full border border-white/10 px-4 py-3 text-sm font-semibold text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue with X
        </button>
        {!clientEnv.X_OAUTH_ENABLED && (
          <p className="mt-2 text-center text-xs text-text-tertiary">X sign-in arrives soon.</p>
        )}
      </div>
    </main>
  );
}
