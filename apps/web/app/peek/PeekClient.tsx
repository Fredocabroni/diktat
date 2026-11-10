// "Look around first" preview surface. Renders today's Drop (or the
// most recent one) in read-only mode and surfaces a clear "pick a
// tribe to join in" CTA. No voting, no composer, no comments panel.
//
// This is a trust-UP affordance (ADDICTION_ARCHITECTURE §10 autonomy):
// the un-onboarded user can see what the product actually is before
// committing to a tribe.

'use client';

import Link from 'next/link';

import { DropCard, type DropCardTopic, type DropCardVariant } from '../../components/drop/DropCard';
import { trpc } from '../../lib/trpc';

export function PeekClient(): React.JSX.Element {
  const list = trpc.feed.list.useQuery();

  if (list.isLoading) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6 text-text-secondary">
        loading.
      </main>
    );
  }

  const topics = list.data?.topics ?? [];
  const topic = topics[0];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-text-primary">a peek inside.</h1>
          <p className="mt-2 text-sm text-text-secondary">
            one Drop a day. this is today&rsquo;s. picking a tribe unlocks the vote.
          </p>
        </div>
        <Link
          href="/onboard/welcome"
          className="whitespace-nowrap rounded-full border border-ink-300 px-3 py-1.5 text-xs text-text-tertiary underline underline-offset-2"
        >
          back
        </Link>
      </header>

      {topic ? (
        <DropCard
          topic={toCardTopic(topic)}
          variant={variantOf(topic)}
          onStance={() => {
            /* read-only */
          }}
          readOnly
        />
      ) : (
        <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center text-text-secondary">
          no Drop to show yet.
        </div>
      )}

      <Link
        href="/onboard/tribe"
        data-component="PeekClient.TribeCta"
        className="rounded-full bg-brand-accent px-4 py-3 text-center text-sm font-semibold text-brand-accent-fg"
      >
        pick a tribe to join in
      </Link>
    </main>
  );
}

function toCardTopic(topic: {
  readonly id: string;
  readonly headline: string;
  readonly sourceTitle: string | null;
  readonly summary: string | null;
  readonly primarySourceUrl: string | null;
  readonly category: string | null;
  readonly factExplainer: DropCardTopic['factExplainer'];
}): DropCardTopic {
  return {
    id: topic.id,
    headline: topic.headline,
    sourceTitle: topic.sourceTitle,
    summary: topic.summary,
    primarySourceUrl: topic.primarySourceUrl,
    category: topic.category,
    factExplainer: topic.factExplainer ?? null,
  };
}

function variantOf(topic: { readonly dropAt: string | null }): DropCardVariant {
  if (!topic.dropAt) return 'pre_drop';
  return Date.parse(topic.dropAt) > Date.now() ? 'pre_drop' : 'live';
}
