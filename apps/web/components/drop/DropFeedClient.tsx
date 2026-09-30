// Drop state machine. Fetches today's Drop via trpc.feed.list, branches
// into one of three render states, and wires stance actions to
// trpc.feed.recordShift. Sits inside the (app) auth-gated layout.
//
// Per-submit idempotency (#127 H11 PR B2):
//   * On tap, generate crypto.randomUUID() as `clientKey` unless there is
//     already a pending key for this topic (i.e. a prior tap that hasn't
//     resolved yet — either mid-flight or failed with the button now
//     showing "tap to retry"). In that case reuse the SAME key so the
//     retry hits the server's 23505 idempotency path and returns the
//     original row instead of writing a duplicate.
//   * On success, delete the key. The NEXT tap on the same topic — a
//     genuine change-of-mind — mints a fresh key and writes a new row.
//   * On failure, keep the key AND surface a small inline "couldn't
//     save — tap to retry" affordance so the user knows the stance did
//     not stick. `.mutateAsync` inside try/catch is the only path so a
//     rejected promise cannot silently die like the pre-fix `.mutate()`
//     did.

'use client';

import { useCallback, useRef, useState } from 'react';

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

  // Pending client_key per topic. A ref (not state) because updates
  // don't need to trigger a re-render; the mutation object's own
  // isPending / the `saveError` state below drive the UI.
  const pendingKeys = useRef<Map<string, string>>(new Map());
  // Per-topic "last save failed" flag so the UI can show a retry
  // affordance. Cleared on the next successful save for that topic.
  const [saveErrorTopicId, setSaveErrorTopicId] = useState<string | null>(null);

  const onStance = useCallback(
    async (topicId: string, action: StanceAction) => {
      if (action === 'skip') return;
      // Reuse an existing pending key for this topic (a retry after a
      // failed submit) OR mint a new one. On success we clear the entry
      // so the NEXT tap always gets a fresh key — which is what makes
      // change-of-mind write a new row rather than idempotently return
      // the previous one.
      let clientKey = pendingKeys.current.get(topicId);
      if (!clientKey) {
        clientKey = crypto.randomUUID();
        pendingKeys.current.set(topicId, clientKey);
      }
      try {
        await recordShift.mutateAsync({
          topicId,
          beforePosition: 0,
          afterPosition: action === 'agree' ? 1 : -1,
          clientKey,
        });
        pendingKeys.current.delete(topicId);
        // Clear any stale error banner for THIS topic; other topics'
        // errors are unaffected.
        setSaveErrorTopicId((current) => (current === topicId ? null : current));
      } catch {
        // Retain the pending key. The next tap on this topic reuses it,
        // so the server's 23505 idempotency path returns the original
        // row if the failure was after the write hit the DB, or a
        // fresh insert if it was earlier. Either way the user does not
        // double-write.
        setSaveErrorTopicId(topicId);
      }
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
          onStance={(action) => void onStance(state.topic.id, action)}
          disabled={recordShift.isPending}
          saveError={saveErrorTopicId === state.topic.id}
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
  readonly saveError: boolean;
}

function DropFlow({
  topic,
  variant,
  onStance,
  disabled,
  saveError,
}: DropFlowProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <DropCard
        topic={topic}
        variant={variant}
        onStance={onStance}
        disabled={disabled}
        banner={topic.isBlockExhausted ? <BlockExhaustedBanner /> : null}
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
