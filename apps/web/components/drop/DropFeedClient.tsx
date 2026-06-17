// Drop state machine. Fetches today's Drop via trpc.feed.list, branches
// into one of three render states, and wires stance actions to
// trpc.feed.recordShift. Sits inside the (app) auth-gated layout.

'use client';

import { useCallback } from 'react';

import { trpc } from '../../lib/trpc';

import { BlockExhaustedBanner } from './BlockExhaustedBanner';
import { DropCard, type DropCardVariant, type StanceAction } from './DropCard';
import { NextDropCountdown } from './NextDropCountdown';

interface DropTopic {
  readonly id: string;
  readonly headline: string;
  readonly sourceTitle: string | null;
  readonly summary: string | null;
  readonly primarySourceUrl: string | null;
  readonly category: string | null;
  readonly dropAt: string | null;
  readonly isBlockExhausted: boolean;
}

type DropState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'live'; topic: DropTopic }
  | { kind: 'pre_drop'; topic: DropTopic };

function classify(topic: DropTopic | undefined, now: Date): DropState {
  if (!topic) return { kind: 'empty' };
  if (!topic.dropAt) return { kind: 'empty' };
  if (Date.parse(topic.dropAt) > now.getTime()) {
    // Future-dated drop_at: the pipeline doesn't produce these today
    // (drop_publish stamps at publish time), but defend against the
    // case anyway so a stale clock doesn't surface as "live."
    return { kind: 'pre_drop', topic };
  }
  // The drop_at has passed. If it belongs to today's ET calendar day,
  // it's live; otherwise it's yesterday's (or earlier) fallback.
  // The server-side query already returns the most-recent past Drop,
  // so we only need to compare ET dates here.
  const todayEtYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const dropEtYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(topic.dropAt));
  return dropEtYmd === todayEtYmd ? { kind: 'live', topic } : { kind: 'pre_drop', topic };
}

export function DropFeedClient(): React.JSX.Element {
  const list = trpc.feed.list.useQuery();
  const recordShift = trpc.feed.recordShift.useMutation();

  const onStance = useCallback(
    (topicId: string, action: StanceAction) => {
      if (action === 'skip') return;
      recordShift.mutate({
        topicId,
        beforePosition: 0,
        afterPosition: action === 'agree' ? 1 : -1,
      });
    },
    [recordShift],
  );

  const state: DropState = list.isLoading
    ? { kind: 'loading' }
    : list.error
      ? { kind: 'error' }
      : classify(list.data?.topics[0], new Date());

  return (
    <section className="mx-auto max-w-md px-4 py-6">
      {state.kind === 'loading' ? <StatusPanel text="Loading today's Drop." /> : null}
      {state.kind === 'error' ? (
        <StatusPanel text="Could not load today's Drop." tone="danger" />
      ) : null}
      {state.kind === 'empty' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center">
            <p className="font-display text-lg font-semibold text-text-primary">
              The first Drop lands at 8 PM ET tonight.
            </p>
            <p className="mt-2 text-sm text-text-secondary">
              One topic. Real sources. Pick a side.
            </p>
          </div>
          <NextDropCountdown />
        </div>
      ) : null}
      {state.kind === 'live' || state.kind === 'pre_drop' ? (
        <DropFlow
          topic={state.topic}
          variant={state.kind === 'live' ? 'live' : 'pre_drop'}
          onStance={(action) => onStance(state.topic.id, action)}
          disabled={recordShift.isPending}
        />
      ) : null}
    </section>
  );
}

interface DropFlowProps {
  readonly topic: DropTopic;
  readonly variant: DropCardVariant;
  readonly onStance: (action: StanceAction) => void;
  readonly disabled: boolean;
}

function DropFlow({ topic, variant, onStance, disabled }: DropFlowProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <DropCard
        topic={topic}
        variant={variant}
        onStance={onStance}
        disabled={disabled}
        banner={topic.isBlockExhausted ? <BlockExhaustedBanner /> : null}
      />
      {variant === 'pre_drop' ? <NextDropCountdown /> : null}
    </div>
  );
}

function StatusPanel({
  text,
  tone,
}: {
  readonly text: string;
  readonly tone?: 'danger';
}): React.JSX.Element {
  const toneClass = tone === 'danger' ? 'text-danger' : 'text-text-secondary';
  return (
    <div
      className={`rounded-2xl border border-ink-300 bg-surface-card p-6 text-center ${toneClass}`}
    >
      {text}
    </div>
  );
}
