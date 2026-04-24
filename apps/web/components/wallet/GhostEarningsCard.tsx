// Ghost-earnings card for tiers 0–2. The AP engine credits these when a
// user wins a prediction or battle below the payout-eligible tier — the
// system "would have" paid out and logs the number so the user can see
// what they'd earn once they reach tier 3. The floor is opt-in visibility,
// not a nag: the card is informational, never blocks content.

'use client';

import { trpc } from '../../lib/trpc';

export function GhostEarningsCard() {
  const q = trpc.wallet.ghostEarnings.useQuery();

  if (q.isLoading || !q.data) return null;
  if (q.data.totalAp <= 0) return null;

  return (
    <section className="rounded-2xl border border-ink-300 bg-surface-card p-4">
      <h2 className="text-xs uppercase tracking-wide text-text-tertiary">Ghost earnings</h2>
      <p className="mt-1 font-display text-2xl font-bold text-text-primary">{q.data.totalAp} AP</p>
      <p className="mt-2 text-sm text-text-secondary">
        What you would have earned at tier 3. Payouts unlock at tier 3.
      </p>
    </section>
  );
}
