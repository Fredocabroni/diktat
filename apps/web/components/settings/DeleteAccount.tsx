// Self-serve account deletion. Operator contract (compliance batch):
// one plain confirmation, no guilt copy, no "are you sure?" dark
// pattern, no retention nudge. Click Delete → short, factual
// confirmation → click Delete again to confirm. The two surfaces
// never render together; the Cancel button is a plain opt-out.
//
// Delete path:
//   trpc.user.deleteAccount → service-role admin.deleteUser(ctx.userId)
//   → CASCADE through public.users on every private row → ledger rows
//   in ap_transactions anonymize to user_id=NULL via migration
//   20261110000000.
// After success: sign out and route to /login. The user cannot land
// back in the (app) shell because their session cookie is gone and
// their row no longer exists.

'use client';

import { useState } from 'react';

import { getBrowserSupabaseClient } from '../../lib/supabase/browser';
import { trpc } from '../../lib/trpc';

type Phase = 'idle' | 'confirm' | 'deleting' | 'error';

export function DeleteAccount(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const del = trpc.user.deleteAccount.useMutation();

  async function onDelete(): Promise<void> {
    setPhase('deleting');
    setErrorMsg(null);
    try {
      await del.mutateAsync();
      // Sign out locally so the stale cookie doesn't try to render
      // the (app) shell against a row that no longer exists.
      const supabase = getBrowserSupabaseClient();
      await supabase.auth.signOut();
      window.location.href = '/login';
    } catch (err) {
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : 'Could not delete account. Try again.');
    }
  }

  if (phase === 'confirm') {
    return (
      <section
        data-component="DeleteAccount.Confirm"
        className="mt-8 rounded-2xl border border-danger/50 bg-surface-card p-5"
      >
        <h2 className="font-display text-base font-semibold text-text-primary">
          Delete your account
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          This permanently deletes your account. Arena Points history is kept anonymously for ledger
          integrity. Everything else is removed.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => void onDelete()}
            data-component="DeleteAccount.Confirm.Delete"
            className="rounded-full bg-danger px-4 py-2 text-sm font-semibold text-danger-fg transition hover:opacity-90"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setPhase('idle')}
            data-component="DeleteAccount.Confirm.Cancel"
            className="rounded-full border border-ink-400 px-4 py-2 text-sm font-semibold text-text-secondary transition hover:border-ink-500 hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      data-component="DeleteAccount"
      className="mt-8 rounded-2xl border border-ink-300 bg-surface-card p-5"
    >
      <h2 className="font-display text-base font-semibold text-text-primary">
        Delete your account
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Removes your account and personal data. Not reversible.
      </p>
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          setPhase('confirm');
        }}
        disabled={phase === 'deleting'}
        data-component="DeleteAccount.Start"
        className="mt-4 rounded-full border border-danger/50 px-4 py-2 text-sm font-semibold text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {phase === 'deleting' ? 'Deleting…' : 'Delete my account'}
      </button>
      {phase === 'error' && errorMsg ? (
        <p role="alert" className="mt-3 text-sm text-danger-soft-fg">
          {errorMsg}
        </p>
      ) : null}
    </section>
  );
}
