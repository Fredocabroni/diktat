// Root state-machine client for open_debate battles. Polls
// trpc.debates.getBattle every 2s while the battle is live, picks the
// "current round" (highest emitted), and branches into the right
// leaf component:
//
//   round_no 0-2 + awaiting_arguments  → ComposeRound (handles its own
//                                         submitted-waiting branch)
//   round_no 0-2 + revealed             → RevealRound  (PR 4.6 commit 3)
//   round_no 3   + awaiting_final_vote  → VotePanel | VotingPending
//                                         (PR 4.6 commit 4)
//   battle.status = 'settled'           → VerdictCard (PR 4.6 commit 5)
//
// Non-participant observers see read-only renders of the same screens.
// During the live debate window, observer access to the battle row is
// unlocked by an additive RLS policy that lands with PR 4.6 commit 4.

'use client';

import { useMemo } from 'react';

import { trpc } from '../../lib/trpc';

import { ComposeRound } from './ComposeRound';

interface OpenDebateClientProps {
  readonly battleId: string;
  readonly currentUserId: string;
}

interface RoundRow {
  readonly id: string;
  readonly round_no: number;
  readonly payload: Record<string, unknown> | null;
  readonly deadline_at: string | null;
  readonly winner_user_id: string | null;
}

interface ArgumentRow {
  readonly round_id: string;
  readonly user_id: string;
  readonly text: string;
  readonly submitted_at: string;
}

interface ParticipantRow {
  readonly user_id: string;
  readonly seat: number;
  readonly entry_ap: number;
  readonly result: string | null;
}

export function OpenDebateClient({
  battleId,
  currentUserId,
}: OpenDebateClientProps): React.JSX.Element {
  const battleQuery = trpc.debates.getBattle.useQuery(
    { battleId },
    {
      refetchInterval: 2_000,
      // Stop polling once settled — verdict is static.
      refetchIntervalInBackground: false,
    },
  );

  const isLoading = battleQuery.isLoading;
  const error = battleQuery.error;
  const data = battleQuery.data;

  const currentState = useMemo(() => {
    if (!data) return null;
    return computeCurrentState({
      participants: data.participants as ParticipantRow[],
      rounds: data.rounds as RoundRow[],
      argumentsList: data.arguments as ArgumentRow[],
      currentUserId,
      battleStatus: data.battle.status,
    });
  }, [data, currentUserId]);

  if (isLoading) return <StatusPanel text="Loading debate." />;
  if (error) return <StatusPanel text="Could not load this debate." tone="danger" />;
  if (!data || !currentState) return <StatusPanel text="Loading debate." />;

  const refetch = () => {
    void battleQuery.refetch();
  };

  switch (currentState.kind) {
    case 'waiting_for_first_round':
      return <StatusPanel text="Waiting for the first round." />;
    case 'compose':
      return (
        <ComposeRound
          roundId={currentState.roundId}
          roundNo={currentState.roundNo}
          deadlineAt={currentState.deadlineAt}
          existingText={currentState.existingText}
          onMutationSettled={refetch}
        />
      );
    case 'observer_awaiting_arguments':
      return (
        <StatusPanel text="Round in progress. Arguments reveal when both submit or the deadline passes." />
      );
    case 'revealed':
      return (
        <Placeholder
          label={`Round ${currentState.roundNo + 1} revealed`}
          note="RevealRound lands in commit 3."
        />
      );
    case 'awaiting_final_vote_participant':
      return <Placeholder label="Voting open" note="VotingPending lands in commit 4." />;
    case 'awaiting_final_vote_observer':
      return (
        <Placeholder
          label="Vote — which argument was stronger?"
          note="VotePanel lands in commit 4."
        />
      );
    case 'scored':
      return <Placeholder label="Verdict" note="VerdictCard lands in commit 5." />;
    case 'settled_without_verdict_round':
      return <Placeholder label="Settled" note="VerdictCard lands in commit 5." />;
  }
}

type CurrentState =
  | { kind: 'waiting_for_first_round' }
  | {
      kind: 'compose';
      roundId: string;
      roundNo: number;
      deadlineAt: string | null;
      existingText: string | null;
    }
  | { kind: 'observer_awaiting_arguments' }
  | { kind: 'revealed'; roundNo: number }
  | { kind: 'awaiting_final_vote_participant' }
  | { kind: 'awaiting_final_vote_observer' }
  | { kind: 'scored' }
  | { kind: 'settled_without_verdict_round' };

function computeCurrentState(input: {
  participants: ParticipantRow[];
  rounds: RoundRow[];
  argumentsList: ArgumentRow[];
  currentUserId: string;
  battleStatus: string;
}): CurrentState | null {
  const { participants, rounds, argumentsList, currentUserId, battleStatus } = input;
  const isParticipant = participants.some((p) => p.user_id === currentUserId);

  if (rounds.length === 0) {
    return { kind: 'waiting_for_first_round' };
  }

  // The runner emits rounds in order, so the current round is the last.
  const current = rounds[rounds.length - 1];
  const state = roundState(current?.payload);

  if (battleStatus === 'settled' || state === 'scored') {
    if (current && current.round_no === 3) return { kind: 'scored' };
    return { kind: 'settled_without_verdict_round' };
  }

  if (!current) return null;

  if (current.round_no === 3) {
    if (state === 'awaiting_final_vote') {
      return isParticipant
        ? { kind: 'awaiting_final_vote_participant' }
        : { kind: 'awaiting_final_vote_observer' };
    }
    return { kind: 'scored' };
  }

  // Argument rounds 0/1/2.
  if (state === 'revealed') {
    return { kind: 'revealed', roundNo: current.round_no };
  }

  if (state === 'awaiting_arguments') {
    if (!isParticipant) return { kind: 'observer_awaiting_arguments' };
    const existing = argumentsList.find(
      (a) => a.round_id === current.id && a.user_id === currentUserId,
    );
    return {
      kind: 'compose',
      roundId: current.id,
      roundNo: current.round_no,
      deadlineAt: current.deadline_at,
      existingText: existing ? existing.text : null,
    };
  }

  return null;
}

function roundState(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  const state = (payload as { state?: unknown }).state;
  return typeof state === 'string' ? state : '';
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

// Throwaway placeholder rendered for states that ship in later 4.6 commits.
// Removed once the corresponding component lands.
function Placeholder({
  label,
  note,
}: {
  readonly label: string;
  readonly note: string;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center">
      <p className="font-display text-lg font-semibold text-text-primary">{label}</p>
      <p className="mt-2 text-xs text-text-secondary">{note}</p>
    </div>
  );
}
