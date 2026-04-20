// Profile screen. Renders the player's tier badge, handle, AP, streak,
// and freeze tokens. Handle is editable via the modal — uniqueness is
// enforced by the citext UNIQUE index on `users.handle`, mapped to a
// CONFLICT TRPCError in the wallet/user router.

'use client';

import { TierBadge, type TierNumber } from '@diktat/ui';
import { useState } from 'react';

import { HandleEditModal } from '../../../components/profile/HandleEditModal';
import { trpc } from '../../../lib/trpc';

export default function ProfilePage() {
  const [editing, setEditing] = useState(false);
  const profile = trpc.user.me.useQuery();

  if (profile.isLoading) {
    return (
      <section className="mx-auto max-w-md px-4 py-6">
        <h1 className="font-display text-2xl font-bold">Profile</h1>
        <p className="mt-4 text-text-secondary">Loading…</p>
      </section>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <section className="mx-auto max-w-md px-4 py-6">
        <h1 className="font-display text-2xl font-bold">Profile</h1>
        <p className="mt-4 text-accent-danger">
          Profile didn&rsquo;t load. Pull to refresh, or try again in a minute.
        </p>
      </section>
    );
  }

  const me = profile.data;
  const displayName = me.display_name ?? me.handle;

  return (
    <section className="mx-auto flex max-w-md flex-col items-center px-4 py-8">
      <TierBadge tier={(me.tier_id as TierNumber) ?? 0} size="xl" showLabel glow />

      <h1 className="mt-5 font-display text-2xl font-bold">{displayName}</h1>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-1 text-sm text-text-secondary underline-offset-4 hover:underline"
      >
        @{me.handle}
      </button>

      <dl className="mt-8 grid w-full grid-cols-3 gap-3 text-center">
        <div className="rounded-2xl bg-surface-elevated p-4">
          <dt className="text-xs uppercase tracking-wide text-text-tertiary">AP</dt>
          <dd className="mt-1 font-display text-2xl font-bold">{me.current_ap}</dd>
        </div>
        <div className="rounded-2xl bg-surface-elevated p-4">
          <dt className="text-xs uppercase tracking-wide text-text-tertiary">Streak</dt>
          <dd className="mt-1 font-display text-2xl font-bold">
            {me.streaks?.current_length ?? 0}
          </dd>
        </div>
        <div className="rounded-2xl bg-surface-elevated p-4">
          <dt className="text-xs uppercase tracking-wide text-text-tertiary">Freeze</dt>
          <dd className="mt-1 font-display text-2xl font-bold">{me.streaks?.freeze_tokens ?? 0}</dd>
        </div>
      </dl>

      {editing && (
        <HandleEditModal
          initialHandle={me.handle}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
    </section>
  );
}
