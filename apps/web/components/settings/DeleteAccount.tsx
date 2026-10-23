// Self-serve account deletion. Operator contract (compliance batch):
// one plain confirmation, no guilt copy, no "are you sure?" dark
// pattern, no retention nudge. Click Delete → short, factual
// confirmation → click Delete again to confirm. The two surfaces
// never render together; the Cancel button is a plain opt-out.
//
// Server-side gates (all enforced by migration 20261110000000):
//   - Recent sign-in required (within the last 10 minutes). An
//     UNAUTHORIZED with `recent_auth_required` steers the user to
//     sign in again — the component renders a one-line prompt and a
//     link to /login.
//   - Not currently in a live battle. A FORBIDDEN with
//     `in_live_battle` tells the user to finish, then come back.
//   - Not currently queued in matchmaking. Same shape as above
//     (`in_matchmaking`).
//
// Delete path on success:
//   trpc.user.deleteAccount → delete_my_account RPC (scrubs
//   idempotency keys of the caller's UUID) → service-role
//   admin.deleteUser(ctx.userId) → CASCADE through public.users on
//   every private row → ledger rows in ap_transactions anonymize to
//   user_id=NULL via migration 20261110000000.
// Then: sign out locally and route to /login.

'use client';

import { useState } from 'react';

import { getBrowserSupabaseClient } from '../../lib/supabase/browser';
import { trpc } from '../../lib/trpc';

type Phase = 'idle' | 'confirm' | 'deleting' | 'error' | 'recent_auth' | 'blocked';

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
      // tRPC-typed error paths — surface the three server-side gates
      // as distinct, actionable client states.
      const data = (err as { data?: { code?: string } } | null)?.data;
      const cause = (err as { shape?: { data?: { cause?: string } } } | null)?.shape?.data?.cause;
      const code = data?.code;
      const msg = err instanceof Error ? err.message : '';
      if (
        code === 'UNAUTHORIZED' ||
        cause === 'recent_auth_required' ||
        /sign in again/i.test(msg)
      ) {
        setPhase('recent_auth');
        setErrorMsg(null);
        return;
      }
      if (code === 'FORBIDDEN') {
        setPhase('blocked');
        setErrorMsg(msg);
        return;
      }
      setPhase('error');
      setErrorMsg(msg || 'Could not delete account. Try again.');
    }
  }

  async function onReSignIn(): Promise<void> {
    const supabase = getBrowserSupabaseClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  if (phase === 'recent_auth') {
    return (
      <section
        data-component="DeleteAccount.RecentAuth"
        className="mt-8 rounded-2xl border border-ink-300 bg-surface-card p-5"
      >
        <h2 className="font-display text-base font-semibold text-text-primary">
          Delete your account
        </h2>
        <p className="mt-2 text-sm text-text-secondary">Sign in again to delete your account.</p>
        <button
          type="button"
          onClick={() => void onReSignIn()}
          data-component="DeleteAccount.RecentAuth.ReSignIn"
          className="mt-4 rounded-full border border-danger/50 px-4 py-2 text-sm font-semibold text-danger transition hover:bg-danger/10"
        >
          Sign in again
        </button>
      </section>
    );
  }

  if (phase === 'blocked') {
    return (
      <section
        data-component="DeleteAccount.Blocked"
        className="mt-8 rounded-2xl border border-ink-300 bg-surface-card p-5"
      >
        <h2 className="font-display text-base font-semibold text-text-primary">
          Delete your account
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          {errorMsg ?? 'Finish your current battle or leave the matchmaking queue, then try again.'}
        </p>
        <button
          type="button"
          onClick={() => {
            setErrorMsg(null);
            setPhase('idle');
          }}
          data-component="DeleteAccount.Blocked.Back"
          className="mt-4 rounded-full border border-ink-400 px-4 py-2 text-sm font-semibold text-text-secondary transition hover:border-ink-500 hover:text-text-primary"
        >
          Back
        </button>
      </section>
    );
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
