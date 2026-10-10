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
import { DropCard, type DropCardVariant, type SelectedStance, type StanceAction } from './DropCard';
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
  /** User's latest stance on this topic from feed.list. null = user
   *  hasn't shifted on this topic yet. (P2.a server-side load.) */
  readonly userStance: SelectedStance;
  /** A4 fact explainer. Null when generation failed or row pre-dates
   *  A4 — DropCard falls through to the raw primary_source_url link. */
  readonly factExplainer: {
    readonly for_summary: string;
    readonly against_summary: string;
    readonly source_url: string;
    readonly posture: 'contested' | 'single_sided' | 'empirical';
  } | null;
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
  // Per-topic optimistic selected stance. P2.a: the moment the user
  // taps, this map holds the chosen stance so the button goes sticky-
  // on immediately. On success it stays set (matching what the server
  // now holds); on failure it's reverted and the red "couldn't save"
  // affordance renders instead. Server-side `userStance` from feed.list
  // is the baseline on first render and on reload — this map only
  // overrides it mid-session.
  const [optimisticStance, setOptimisticStance] = useState<Record<string, SelectedStance>>({});

  const onStance = useCallback(
    async (topicId: string, action: StanceAction) => {
      if (action === 'skip') return;
      // Optimistic selected state. Flipped BEFORE the mutation so the
      // UI responds instantly to the tap; reverted in the catch below
      // if the write fails.
      const newStance: SelectedStance = action === 'agree' ? 'agree' : 'disagree';
      const priorOptimistic = optimisticStance[topicId];
      setOptimisticStance((current) => ({ ...current, [topicId]: newStance }));
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
          // beforePosition is derived server-side from the user's latest
          // shift on this topic (#136 / H13). Any client-sent value is
          // ignored anyway; dropping it keeps the type contract honest.
          afterPosition: action === 'agree' ? 1 : -1,
          clientKey,
        });
        pendingKeys.current.delete(topicId);
        // Clear any stale error banner for THIS topic; other topics'
        // errors are unaffected.
        setSaveErrorTopicId((current) => (current === topicId ? null : current));
      } catch {
        // Revert optimistic selection to whatever it was before the tap
        // (either a prior optimistic stance or `undefined`, which falls
        // through to the server-side baseline).
        setOptimisticStance((current) => {
          const next = { ...current };
          if (priorOptimistic === undefined) delete next[topicId];
          else next[topicId] = priorOptimistic;
          return next;
        });
        // Retain the pending key. The next tap on this topic reuses it,
        // so the server's 23505 idempotency path returns the original
        // row if the failure was after the write hit the DB, or a
        // fresh insert if it was earlier. Either way the user does not
        // double-write.
        setSaveErrorTopicId(topicId);
      }
    },
    [recordShift, optimisticStance],
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
          selected={
            // Optimistic selection overrides server state so the UI
            // responds instantly to a tap; server state is the baseline
            // on first render and after reload.
            optimisticStance[state.topic.id] ?? state.topic.userStance
          }
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
  readonly selected: SelectedStance;
}

function DropFlow({
  topic,
  variant,
  onStance,
  disabled,
  saveError,
  selected,
}: DropFlowProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <DropCard
        topic={topic}
        variant={variant}
        onStance={onStance}
        disabled={disabled}
        selected={selected}
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
