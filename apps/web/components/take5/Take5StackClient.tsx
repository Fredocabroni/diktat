// Take 5 archive stack. P4 PR B.
//
// Fetches up to 5 archive Drops via trpc.take5.getStack, renders them
// one at a time using the same DropCard component Home uses, and
// writes stances through trpc.take5.recordShift. The RPC enforces the
// per-ET-day cap of 5 and credits the Take 5 streak via its inner
// delegation to record_opinion_shift (migration 20261105000000).
//
// Design constraints the user set for this surface (operator contract):
//   * Done state = ONE modest tick + ONE short line + Home link.
//     NO confetti. NO autoplay. NO "come back tomorrow" nudge.
//   * Empty state = ONE honest line + Home link. No bait.
//   * Autonomy preserved: skip advances the local stack without
//     recording a stance (the streak trigger only credits actual
//     opinion_shifts rows, so a skip-through session honestly earns
//     nothing — never a fake tick).
//
// Idempotency / optimistic selection mirrors DropFeedClient:
//   * clientKey minted per topic, reused on retry after failure.
//   * On a failed mutate the top card snaps back and a retry prompt
//     appears; the stack never silently loses a stance.

'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';

import { trpc } from '../../lib/trpc';
import type { DropCardTopic, StanceAction } from '../drop/DropCard';
import { DropCard } from '../drop/DropCard';

interface CardRow {
  readonly id: string;
  readonly headline: string;
  readonly source_title: string | null;
  readonly summary: string | null;
  readonly primary_source_url: string | null;
  readonly category: string | null;
  readonly drop_at: string | null;
  readonly fact_explainer: unknown;
}

type FactExplainer = NonNullable<DropCardTopic['factExplainer']>;

function isFactExplainer(value: unknown): value is FactExplainer {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.for_summary === 'string' &&
    typeof o.against_summary === 'string' &&
    typeof o.source_url === 'string' &&
    (o.posture === 'contested' || o.posture === 'single_sided' || o.posture === 'empirical')
  );
}

function toTopic(row: CardRow): DropCardTopic {
  return {
    id: row.id,
    headline: row.headline,
    sourceTitle: row.source_title,
    summary: row.summary,
    primarySourceUrl: row.primary_source_url,
    category: row.category,
    factExplainer: isFactExplainer(row.fact_explainer) ? row.fact_explainer : null,
  };
}

export function Take5StackClient(): React.JSX.Element {
  const stack = trpc.take5.getStack.useQuery();
  const recordShift = trpc.take5.recordShift.useMutation();

  // Local stack cursor. Starts at 0; advances on every tap (whether
  // the user stanced or skipped). Done when `cursor >= cards.length`.
  const [cursor, setCursor] = useState(0);
  const pendingKeys = useRef<Map<string, string>>(new Map());
  const [saveError, setSaveError] = useState(false);

  const cards = stack.data?.cards ?? [];
  const total = cards.length;

  const onStance = useCallback(
    async (card: CardRow, action: StanceAction) => {
      if (action === 'skip') {
        setSaveError(false);
        setCursor((c) => c + 1);
        return;
      }
      let clientKey = pendingKeys.current.get(card.id);
      if (!clientKey) {
        clientKey = crypto.randomUUID();
        pendingKeys.current.set(card.id, clientKey);
      }
      try {
        await recordShift.mutateAsync({
          topicId: card.id,
          afterPosition: action === 'agree' ? 1 : -1,
          clientKey,
        });
        pendingKeys.current.delete(card.id);
        setSaveError(false);
        setCursor((c) => c + 1);
      } catch {
        // Retain the pending key: a retry on the same card reuses it
        // so a mid-flight write that actually landed on the DB side
        // comes back as a 23505 idempotency hit instead of a second
        // write. The top card stays in place; the inline prompt tells
        // the user the tap didn't stick.
        setSaveError(true);
      }
    },
    [recordShift],
  );

  if (stack.isLoading) {
    return <StatusPanel text="Loading your Take 5." />;
  }
  if (stack.error) {
    // Fail-closed on getStack error — same posture as the server-side
    // fail-closed in take5.getStack. Showing a stack we can't trust
    // would be worse than nothing. Honest line + Home link.
    return (
      <EmptyOrDone
        line="Couldn't load the archive."
        subLine="Head home and try again."
        tone="danger"
      />
    );
  }
  if (total === 0) {
    return (
      <EmptyOrDone line="Nothing in the archive right now." subLine="The 7-day window is thin." />
    );
  }
  if (cursor >= total) {
    return <DonePanel />;
  }

  const card = cards[cursor]!;
  return (
    <div className="flex flex-col gap-4">
      <p
        data-component="Take5StackClient.Counter"
        className="text-center text-xs uppercase tracking-wide text-text-tertiary"
      >
        card {cursor + 1} of {total}
      </p>
      <DropCard
        topic={toTopic(card)}
        variant="pre_drop"
        onStance={(action) => void onStance(card, action)}
        disabled={recordShift.isPending}
        selected={null}
      />
      {saveError ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          Couldn&rsquo;t save your stance. Tap again to retry.
        </p>
      ) : null}
    </div>
  );
}

function DonePanel(): React.JSX.Element {
  // One tick + one line + a quiet Home link. No celebratory loops,
  // no autoplay, no next-session nudge. This is the whole done
  // state, by design (operator contract, P4 PR B).
  return (
    <div
      data-component="Take5StackClient.Done"
      className="flex flex-col items-center gap-3 rounded-2xl border border-ink-300 bg-surface-card p-8 text-center"
    >
      <span aria-hidden className="text-3xl text-success">
        ✓
      </span>
      <p className="font-display text-lg font-semibold text-text-primary">all done.</p>
      <Link
        href="/"
        className="text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
      >
        Back to Home
      </Link>
    </div>
  );
}

function EmptyOrDone({
  line,
  subLine,
  tone,
}: {
  readonly line: string;
  readonly subLine?: string;
  readonly tone?: 'danger';
}): React.JSX.Element {
  const toneClass = tone === 'danger' ? 'text-danger' : 'text-text-primary';
  return (
    <div
      data-component="Take5StackClient.Empty"
      className="flex flex-col items-center gap-3 rounded-2xl border border-ink-300 bg-surface-card p-8 text-center"
    >
      <p className={`font-display text-lg font-semibold ${toneClass}`}>{line}</p>
      {subLine ? <p className="text-sm text-text-secondary">{subLine}</p> : null}
      <Link
        href="/"
        className="text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
      >
        Back to Home
      </Link>
    </div>
  );
}

function StatusPanel({ text }: { readonly text: string }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center text-text-secondary">
      {text}
    </div>
  );
}
