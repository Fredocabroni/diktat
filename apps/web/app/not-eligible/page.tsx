// Terminal state for accounts whose `age_blocked_at` is set.
// Plain, respectful, no hints about lying. Sign-out button is the
// only affordance.
//
// The (app) layout and the `attestAge` tRPC mutation both redirect
// here on the blocked branch; the account itself cannot re-attest
// (the SECURITY DEFINER RPC refuses further attempts, raising
// `P0001`).

'use client';

import { useState } from 'react';

import { getBrowserSupabaseClient } from '../../lib/supabase/browser';

export default function NotEligiblePage(): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  async function onSignOut(): Promise<void> {
    setBusy(true);
    const supabase = getBrowserSupabaseClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <main
      data-component="NotEligiblePage"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10"
    >
      <h1 className="font-display text-3xl font-bold tracking-tight text-text-primary">
        Diktat is for adults 18+.
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-secondary">
        Thanks for stopping by. This account is not eligible to use Diktat.
      </p>
      <button
        type="button"
        onClick={() => void onSignOut()}
        disabled={busy}
        data-component="NotEligiblePage.SignOut"
        className="mt-8 rounded-xl border border-ink-300 bg-transparent px-4 py-3 text-sm font-semibold text-text-primary disabled:opacity-60"
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </main>
  );
}
