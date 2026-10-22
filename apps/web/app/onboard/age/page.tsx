// 18+ age gate. One screen. The user submits a date of birth; the
// server computes age via the `attestAge` tRPC mutation, which calls
// `attest_age(p_birth_date)` under service-definer. The DOB is never
// stored — the RPC discards it after stamping either `age_verified_at`
// or `age_blocked_at` on the users row.
//
// A verified outcome routes forward to /onboard/welcome (the existing
// onboarding entry) — the (app) layout's redirect order then sends the
// user to the next uncleared gate. A blocked outcome routes to
// /not-eligible (terminal state; the layout treats a non-null
// `age_blocked_at` as a one-way redirect).
//
// Operator contract: NO copy that coaches the "right" answer. The
// /not-eligible page is plain and respectful; the DOB form carries no
// language that implies a particular answer is preferred.

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { VersionSkewNotice } from '../../../components/VersionSkewNotice';
import { trpc } from '../../../lib/trpc';
import { isVersionSkewError } from '../../../lib/trpc-errors';

export default function OnboardAgePage(): React.JSX.Element {
  const router = useRouter();
  const [birthDate, setBirthDate] = useState('');
  // US-only pre-launch gate. The checkbox is `required`, so the form
  // cannot submit while it is false. The attestAge mutation input
  // zod-refines `usResident === true` as defence in depth against a
  // direct-tRPC call that bypasses the UI.
  const [usResident, setUsResident] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Version-skew surfaces when the web bundle lands before api — the
  // `attestAge` procedure returns NOT_FOUND / 404, or the fetch fails
  // outright with no response body. Both get the calm notice; the raw
  // error path is reserved for signals the user can act on (bad DOB).
  const [showSkewNotice, setShowSkewNotice] = useState(false);
  const attest = trpc.user.attestAge.useMutation({
    onSuccess: (outcome) => {
      if (outcome.outcome === 'blocked') {
        router.push('/not-eligible');
        return;
      }
      // verified OR already_verified — move on to the next uncleared
      // gate (the (app) layout decides from there).
      router.push('/');
    },
    onError: (err) => {
      if (isVersionSkewError(err)) {
        setShowSkewNotice(true);
        return;
      }
      // The server returns BAD_REQUEST for a nonsense DOB; keep the
      // user on the page and prompt a correction.
      setError(err.message || 'Could not save. Try again.');
    },
  });

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    setShowSkewNotice(false);
    if (!birthDate) {
      setError('Enter your date of birth.');
      return;
    }
    if (!usResident) {
      setError('Confirm you are a US resident to continue.');
      return;
    }
    attest.mutate({ birthDate, usResident });
  }

  function onRetry(): void {
    setShowSkewNotice(false);
    if (birthDate && usResident) attest.mutate({ birthDate, usResident });
  }

  return (
    <main
      data-component="OnboardAgePage"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-between px-6 py-10"
    >
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight text-text-primary">
          Diktat is for adults 18+.
        </h1>
        <p className="mt-3 text-sm text-text-secondary">
          Enter your date of birth. We check the age and discard the date.
        </p>
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-text-primary">
            <span className="font-medium">Date of birth</span>
            <input
              type="date"
              required
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              data-component="OnboardAgePage.BirthDate"
              className="rounded-xl border border-ink-300 bg-surface-card px-3 py-3 text-text-primary"
            />
          </label>
          <label className="flex items-start gap-3 text-sm text-text-primary">
            <input
              type="checkbox"
              required
              checked={usResident}
              onChange={(e) => setUsResident(e.target.checked)}
              data-component="OnboardAgePage.UsResident"
              className="mt-1 h-4 w-4 rounded border-ink-300"
            />
            <span>I&rsquo;m a US resident.</span>
          </label>
          {showSkewNotice ? <VersionSkewNotice onRetry={onRetry} busy={attest.isPending} /> : null}
          {error && !showSkewNotice ? (
            <p
              role="status"
              aria-live="polite"
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={attest.isPending || showSkewNotice}
            data-component="OnboardAgePage.Submit"
            className="rounded-xl bg-brand-accent px-4 py-3 text-sm font-semibold text-brand-accent-fg disabled:opacity-60"
          >
            {attest.isPending ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
      <p className="text-xs text-text-tertiary">
        We don&rsquo;t store your date of birth. The server reads it, stamps the age check, and
        drops it.
      </p>
    </main>
  );
}
