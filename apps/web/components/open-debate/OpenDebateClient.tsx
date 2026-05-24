// Root state-machine client for open_debate battles. Polls
// trpc.debates.getBattle every 2s while the battle is live, picks the
// "current round" (highest emitted), and branches into the right
// leaf component:
//
//   round_no 0-2 + awaiting_arguments  → ComposeRound (handles its own
//                                         submitted-waiting branch)
//   round_no 0-2 + revealed             → RevealRound
//   round_no 3   + awaiting_final_vote  → VotePanel (observer) |
//                                         VotingPending (participant)
//   battle.status = 'settled'           → VerdictCard

'use client';

import { useMemo } from 'react';

import { trpc } from '../../lib/trpc';

import { ComposeRound } from './ComposeRound';
import { RevealRound } from './RevealRound';
import { VerdictCard } from './VerdictCard';
import { VotePanel } from './VotePanel';
import { VotingPending } from './VotingPending';

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
  readonly users?: { handle: string | null } | null;
}

interface VoteRow {
  readonly voter_user_id: string;
  readonly vote_for_user_id: string;
  readonly ap_at_vote_time: number;
  readonly voted_at: string;
}

export function OpenDebateClient({
  battleId,
  currentUserId,
}: OpenDebateClientProps): React.JSX.Element {
  const battleQuery = trpc.debates.getBattle.useQuery(
    { battleId },
    {
      refetchInterval: 2_000,
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

  const participants = data.participants as ParticipantRow[];
  const argumentsList = data.arguments as ArgumentRow[];
  const rounds = data.rounds as RoundRow[];
  const votes = (data.votes ?? []) as VoteRow[];
  const verdictRound = rounds.find((r) => r.round_no === 3) ?? null;

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
        <RevealRound
          roundNo={currentState.roundNo}
          roundId={currentState.roundId}
          payload={currentState.payload}
          participants={participants}
          argumentsList={argumentsList}
          currentUserId={currentUserId}
        />
      );
    case 'awaiting_final_vote_participant':
      return (
        <VotingPending
          verdictDeadline={currentState.verdictDeadline}
          rounds={rounds}
          participants={participants}
          argumentsList={argumentsList}
          currentUserId={currentUserId}
        />
      );
    case 'awaiting_final_vote_observer':
      return (
        <VotePanel
          battleId={battleId}
          verdictDeadline={currentState.verdictDeadline}
          rounds={rounds}
          participants={participants}
          argumentsList={argumentsList}
          votes={votes}
          currentUserId={currentUserId}
          onMutationSettled={refetch}
        />
      );
    case 'scored':
    case 'settled_without_verdict_round':
      return (
        <VerdictCard
          verdictRound={verdictRound}
          rounds={rounds}
          participants={participants}
          argumentsList={argumentsList}
          currentUserId={currentUserId}
        />
      );
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
  | {
      kind: 'revealed';
      roundNo: number;
      roundId: string;
      payload: Record<string, unknown> | null;
    }
  | { kind: 'awaiting_final_vote_participant'; verdictDeadline: string | null }
  | { kind: 'awaiting_final_vote_observer'; verdictDeadline: string | null }
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
        ? { kind: 'awaiting_final_vote_participant', verdictDeadline: current.deadline_at }
        : { kind: 'awaiting_final_vote_observer', verdictDeadline: current.deadline_at };
    }
    return { kind: 'scored' };
  }

  // Argument rounds 0/1/2.
  if (state === 'revealed') {
    return {
      kind: 'revealed',
      roundNo: current.round_no,
      roundId: current.id,
      payload: current.payload,
    };
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
