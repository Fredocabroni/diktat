// Tribe picker. Shows the five starter tribes seeded in migration 0008.
// Tap a card to join via `tribes.join` (RLS enforces self-only insert
// with weekly_ap=0 / is_primary=false) and proceed to the preview.
// A "Skip for now" link lets the user bypass the tribe step entirely —
// ADDICTION_ARCHITECTURE §11 (no forced choice to proceed, no FOMO).

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { trpc } from '../../../lib/trpc';

export default function OnboardTribePage() {
  const router = useRouter();
  const tribes = trpc.tribes.list.useQuery();
  const [selected, setSelected] = useState<string | null>(null);

  const join = trpc.tribes.join.useMutation({
    onSuccess: () => router.push('/onboard/preview'),
  });

  function pick(tribeId: string) {
    if (join.isPending) return;
    setSelected(tribeId);
    join.mutate({ tribeId });
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-10">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight text-text-primary">
          Choose a tribe
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Start with the one that feels closest. You can change later.
        </p>
      </header>

      <ul className="mt-6 space-y-3">
        {tribes.isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="h-24 animate-pulse rounded-2xl bg-surface-card/60" />
          ))}
        {tribes.data?.map((tribe) => {
          const isPending = join.isPending && selected === tribe.id;
          return (
            <li key={tribe.id}>
              <button
                type="button"
                onClick={() => pick(tribe.id)}
                disabled={join.isPending}
                className="flex w-full flex-col items-start rounded-2xl border border-ink-300 bg-surface-card p-4 text-left transition hover:border-brand hover:bg-surface-raised disabled:opacity-60"
              >
                <p className="font-display text-lg font-bold text-text-primary">{tribe.name}</p>
                {tribe.description && (
                  <p className="mt-1 text-sm text-text-secondary">{tribe.description}</p>
                )}
                {isPending && <p className="mt-2 text-xs text-text-tertiary">Joining…</p>}
              </button>
            </li>
          );
        })}
      </ul>

      {join.error && (
        <p role="alert" className="mt-4 text-sm text-danger-soft-fg">
          Could not join that tribe. Try again, or skip for now.
        </p>
      )}

      <div className="mt-8 flex flex-col items-center gap-2 pb-4">
        <Link
          href="/onboard/preview"
          className="rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
        >
          Skip for now
        </Link>
      </div>
    </main>
  );
}
