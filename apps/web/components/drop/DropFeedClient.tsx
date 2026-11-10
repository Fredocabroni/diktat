// Drop state machine. Fetches today's Drop via trpc.feed.list, branches
// into one of three render states, and wires stance actions to
// trpc.feed.recordShift. Sits inside the (app) auth-gated layout.
//
// Vote interaction is TWO-STEP: choose then lock in.
//
//   1. Tapping Agree/Disagree selects locally. No API call. Tapping
//      the same button again deselects; tapping the other side
//      switches. A "Lock it in" button appears while a selection is
//      pending.
//   2. Lock it in fires `feed.recordShift`. On success the card flips
//      to a locked view with the selected button sticky-on, others
//      dimmed and disabled, and the aggregate split (feed.getSplit)
//      appears below.
//   3. "Changed my mind" reopens the choose view, pre-selecting the
//      currently-locked stance. Locking again writes a new shift with
//      a fresh clientKey (change of mind IS a new row).
//
// Per-submit idempotency (#127 H11 PR B2):
//   * The clientKey map survives the choose step. A pending key for a
//     topic is minted on the first lock-in tap and reused on any
//     retry after an error. On success the key is cleared so the next
//     lock-in (a change of mind) mints a fresh one and writes a new
//     row rather than idempotently returning the previous one.
//   * On failure, the pending key is kept and the choose state is
//     kept (editing stays true), so the user can retry by tapping
//     Lock it in again — the reused key hits the server's 23505 path
//     if the write actually landed, or writes afresh if it did not.
//
// On reload: `feed.list` returns the user's latest stance in
// `topic.userStance`. Non-null → the card mounts in locked view and
// the split loads immediately.
//
// Skip. Tapping Skip collapses the topic card to a slim one-line row
// via `SkippedCard` and smooth-scrolls the next topic container into
// view (with `prefers-reduced-motion` respected — no smooth scroll
// for users who have opted out). Skip NEVER calls recordShift and
// NEVER counts as a stance; if the user has already locked a vote,
// Skip only collapses — the locked stance stands and `undo` restores
// the full locked view in place. Skipped topic ids are persisted in
// sessionStorage under `SKIPPED_STORAGE_KEY` so a same-tab reload
// keeps collapsed cards collapsed; a new tab / new session starts
// clean. Storage access is wrapped in try/catch; failures are no-op
// (private windows, disabled site data).

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { trpc } from '../../lib/trpc';

import { BlockExhaustedBanner } from './BlockExhaustedBanner';
import { DropCard, type DropCardVariant, type SelectedStance, type StanceAction } from './DropCard';
import { NextDropCountdown } from './NextDropCountdown';
import { SkippedCard } from './SkippedCard';
import type { SplitState } from './SplitBar';

// sessionStorage key for the array of skipped topic ids. Namespaced
// so a schema change (v1 → v2) can expire old entries by bumping
// the suffix without wiping the whole storage.
const SKIPPED_STORAGE_KEY = 'diktat:feed:skipped:v1';

function readSkippedFromStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(SKIPPED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeSkippedToStorage(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SKIPPED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Private window / blocked site data / quota — skip state falls
    // back to in-memory-only for this session. No user-visible
    // failure.
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

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
   *  hasn't locked a stance yet. */
  readonly userStance: SelectedStance;
  /** A4 fact explainer. */
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
  | { kind: 'pre_drop'; topic: DropTopic }
  | { kind: 'no_drop_today'; topic: DropTopic };

function classify(topic: DropTopic | undefined, now: Date): DropState {
  if (!topic) return { kind: 'empty' };
  if (!topic.dropAt) return { kind: 'empty' };
  if (Date.parse(topic.dropAt) > now.getTime()) {
    return { kind: 'pre_drop', topic };
  }
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
  return dropEtYmd === todayEtYmd ? { kind: 'live', topic } : { kind: 'no_drop_today', topic };
}

export function DropFeedClient(): React.JSX.Element {
  const list = trpc.feed.list.useQuery();
  const recordShift = trpc.feed.recordShift.useMutation();

  // Pending clientKey per topic. Ref (not state) because its updates
  // don't need to trigger a re-render.
  const pendingKeys = useRef<Map<string, string>>(new Map());
  // Local, pre-submit selection per topic.
  const [chosen, setChosen] = useState<Record<string, SelectedStance>>({});
  // Edit-mode flag per topic. When true for a topic that has a locked
  // stance, the card shows the choose view with the current locked
  // stance pre-selected.
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  // Optimistic locked stance per topic after a successful lock-in.
  // Falls through to server state (`topic.userStance`) when absent.
  const [lockedOptimistic, setLockedOptimistic] = useState<
    Record<string, SelectedStance | undefined>
  >({});
  // Per-topic "last save failed" flag so the UI can show a retry
  // affordance. Cleared on the next successful save for that topic.
  const [saveErrorTopicId, setSaveErrorTopicId] = useState<string | null>(null);
  // Set of topic ids currently in the collapsed "skipped" state.
  // Hydrated once from sessionStorage on mount; updates write back.
  // The write is best-effort (private windows etc. — see
  // writeSkippedToStorage).
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const ids = readSkippedFromStorage();
    if (ids.length === 0) return;
    setSkipped(Object.fromEntries(ids.map((id) => [id, true])));
  }, []);
  // Per-topic DOM wrapper refs so skip can smooth-scroll the NEXT
  // topic card into view. Keyed by topic id; cleaned up as the list
  // changes. Using a Map in a ref avoids a re-render when a wrapper
  // registers.
  const topicRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const registerTopicRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node === null) topicRefs.current.delete(id);
    else topicRefs.current.set(id, node);
  }, []);

  const onSkip = useCallback(
    (topicId: string, allTopicIds: readonly string[]) => {
      setSkipped((current) => {
        if (current[topicId]) return current;
        const nextState = { ...current, [topicId]: true };
        writeSkippedToStorage(Object.keys(nextState));
        return nextState;
      });
      // Find the next not-yet-skipped topic that isn't this one and
      // scroll its wrapper into view. "Last card" (no next topic
      // AFTER this one) → no scroll by design.
      const myIdx = allTopicIds.indexOf(topicId);
      if (myIdx === -1 || myIdx === allTopicIds.length - 1) return;
      const nextId = allTopicIds.slice(myIdx + 1).find((id) => !skipped[id]);
      if (!nextId) return;
      const nextNode = topicRefs.current.get(nextId);
      if (!nextNode) return;
      // scrollIntoView `behavior: 'smooth'` honors the OS/browser
      // reduced-motion setting on modern engines, but we gate here as
      // a belt-and-braces so behaviour is predictable regardless of
      // engine. 'auto' == instant jump.
      try {
        nextNode.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start',
        });
      } catch {
        // scrollIntoView can throw in exotic iframe contexts; no-op.
      }
    },
    [skipped],
  );

  const onUndoSkip = useCallback((topicId: string) => {
    setSkipped((current) => {
      if (!current[topicId]) return current;
      const draft = { ...current };
      delete draft[topicId];
      writeSkippedToStorage(Object.keys(draft));
      return draft;
    });
  }, []);

  const onStance = useCallback(
    (topicId: string, action: StanceAction, allTopicIds: readonly string[]) => {
      if (action === 'skip') {
        onSkip(topicId, allTopicIds);
        return;
      }
      const next: SelectedStance = action === 'agree' ? 'agree' : 'disagree';
      setChosen((current) => {
        const prev = current[topicId] ?? null;
        // Tapping the already-chosen button clears the selection. Any
        // other tap sets / switches.
        if (prev === next) {
          const draft = { ...current };
          delete draft[topicId];
          return draft;
        }
        return { ...current, [topicId]: next };
      });
    },
    [onSkip],
  );

  const onLockIn = useCallback(
    async (topicId: string) => {
      const chosenStance = chosen[topicId];
      if (!chosenStance) return;
      // Reuse a pending clientKey if a prior lock-in for this topic
      // failed. On success we delete the entry so the NEXT lock-in
      // (a change of mind) mints a fresh key and writes a new row.
      let clientKey = pendingKeys.current.get(topicId);
      if (!clientKey) {
        clientKey = crypto.randomUUID();
        pendingKeys.current.set(topicId, clientKey);
      }
      try {
        await recordShift.mutateAsync({
          topicId,
          afterPosition: chosenStance === 'agree' ? 1 : -1,
          clientKey,
        });
        pendingKeys.current.delete(topicId);
        setLockedOptimistic((current) => ({ ...current, [topicId]: chosenStance }));
        setChosen((current) => {
          const draft = { ...current };
          delete draft[topicId];
          return draft;
        });
        setEditing((current) => {
          if (!current[topicId]) return current;
          const draft = { ...current };
          delete draft[topicId];
          return draft;
        });
        setSaveErrorTopicId((current) => (current === topicId ? null : current));
      } catch {
        // Keep chosen + editing so the choose view stays open with
        // the selection visible. The pending clientKey is retained so
        // a retry hits the server's idempotency path if the write
        // actually landed.
        setSaveErrorTopicId(topicId);
      }
    },
    [chosen, recordShift],
  );

  const onChangeMind = useCallback((topicId: string, currentLocked: SelectedStance) => {
    setEditing((current) => ({ ...current, [topicId]: true }));
    setChosen((current) => ({ ...current, [topicId]: currentLocked }));
    // Clear any stale error — the user is restarting the choose
    // step for this topic.
    setSaveErrorTopicId((current) => (current === topicId ? null : current));
  }, []);

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
        <div
          data-component="DropFeedClient.TopicWrapper"
          data-topic-id={state.topic.id}
          ref={(node) => registerTopicRef(state.topic.id, node)}
        >
          {skipped[state.topic.id] ? (
            <SkippedCard
              topicId={state.topic.id}
              headline={state.topic.headline}
              onUndo={() => onUndoSkip(state.topic.id)}
            />
          ) : (
            <DropFlow
              topic={state.topic}
              variant={state.kind === 'live' ? 'live' : 'pre_drop'}
              chosen={chosen[state.topic.id] ?? null}
              editing={Boolean(editing[state.topic.id])}
              lockedOverride={lockedOptimistic[state.topic.id]}
              saveError={saveErrorTopicId === state.topic.id}
              submitting={recordShift.isPending}
              onStance={(action) =>
                // feed.list currently returns at most one topic;
                // pass the single-element id array so the skip
                // next-card scroll logic works forward-compatibly
                // when limit > 1 lands.
                onStance(state.topic.id, action, [state.topic.id])
              }
              onLockIn={() => void onLockIn(state.topic.id)}
              onChangeMind={(currentLocked) => onChangeMind(state.topic.id, currentLocked)}
            />
          )}
        </div>
      ) : null}
      {state.kind === 'no_drop_today' ? <NoDropTodayPanel topic={state.topic} /> : null}
    </section>
  );
}

interface NoDropTodayPanelProps {
  readonly topic: DropTopic;
}

function NoDropTodayPanel({ topic }: NoDropTodayPanelProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div
        data-component="NoDropTodayPanel.Banner"
        className="rounded-2xl border border-ink-300 bg-surface-card p-5"
      >
        <p className="font-display text-lg font-semibold text-text-primary">
          No Drop today. Nothing cleared the bar.
        </p>
        <p className="mt-2 text-sm text-text-secondary">
          Here&rsquo;s yesterday&rsquo;s, read-only. Keep the ritual with Take 5.
        </p>
        <Link
          href="/take5"
          data-component="NoDropTodayPanel.Cta"
          className="mt-4 inline-flex items-center justify-center rounded-xl bg-brand-accent px-4 py-2 text-sm font-semibold text-brand-accent-fg"
        >
          Take 5
        </Link>
      </div>
      <DropCard
        topic={topic}
        variant="pre_drop"
        onStance={() => {
          /* read-only: no stance on the no-Drop replay */
        }}
        locked={topic.userStance}
        readOnly
        banner={topic.isBlockExhausted ? <BlockExhaustedBanner /> : null}
      />
    </div>
  );
}

interface DropFlowProps {
  readonly topic: DropTopic;
  readonly variant: DropCardVariant;
  readonly chosen: SelectedStance;
  readonly editing: boolean;
  readonly lockedOverride: SelectedStance | undefined;
  readonly saveError: boolean;
  readonly submitting: boolean;
  readonly onStance: (action: StanceAction) => void;
  readonly onLockIn: () => void;
  readonly onChangeMind: (currentLocked: SelectedStance) => void;
}

function DropFlow({
  topic,
  variant,
  chosen,
  editing,
  lockedOverride,
  saveError,
  submitting,
  onStance,
  onLockIn,
  onChangeMind,
}: DropFlowProps): React.JSX.Element {
  // The effective locked stance for this render: an optimistic post-
  // lock-in override beats the server baseline from feed.list.
  const locked: SelectedStance = lockedOverride !== undefined ? lockedOverride : topic.userStance;
  const isLockedView = locked !== null && !editing;

  // Fetch split only when we're in locked view. Keeping the query
  // disabled while the user is still choosing avoids wasted calls
  // and keeps the <5 band private on first render.
  const splitQuery = trpc.feed.getSplit.useQuery({ topicId: topic.id }, { enabled: isLockedView });

  // After a successful lock-in, the locked stance changes — refetch
  // the split so the card shows the user's own vote reflected.
  // `splitQuery.refetch` is memoised by react-query (stable across
  // renders unless the query key changes), so including it in the
  // dep array is correct: the effect only re-fires when the locked
  // stance or isLockedView flips, not on every render. Pulling it
  // into a local variable also keeps the next lint cycle happy
  // without an inline eslint-disable (the `react-hooks/exhaustive-
  // deps` rule is not loaded in Next's build-time lint config, so
  // a disable comment there crashes the build).
  const refetchSplit = splitQuery.refetch;
  useEffect(() => {
    if (isLockedView) {
      void refetchSplit();
    }
  }, [locked, isLockedView, refetchSplit]);

  const split: SplitState | undefined = (() => {
    const data = splitQuery.data;
    if (!data) return undefined;
    if (data.early) return { kind: 'early' };
    return {
      kind: 'full',
      agreePct: data.agreePct,
      disagreePct: data.disagreePct,
      total: data.total,
    };
  })();

  return (
    <div className="flex flex-col gap-4">
      <DropCard
        topic={topic}
        variant={variant}
        onStance={onStance}
        onLockIn={onLockIn}
        onChangeMind={() => {
          if (locked !== null) onChangeMind(locked);
        }}
        chosen={chosen}
        locked={locked}
        editing={editing}
        submitting={submitting}
        split={split}
        banner={topic.isBlockExhausted ? <BlockExhaustedBanner /> : null}
      />
      {saveError ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          Save failed. Lock it in to retry.
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
