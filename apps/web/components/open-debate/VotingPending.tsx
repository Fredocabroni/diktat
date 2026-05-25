// Participant-side view during the verdict round's awaiting_final_vote
// window. Participants cannot vote on their own debate (RLS + tRPC
// FORBIDDEN), so this surface is read-only: the timer + the full
// arguments timeline. The verdict card lands when the runner ticks
// scoreAndSettle.

'use client';

import { RoundTimer } from '@diktat/ui';

import { ArgumentsTimeline } from './ArgumentsTimeline';
import { useCountdown } from './useCountdown';

const VOTE_WINDOW_S = 2 * 60;

interface RoundRow {
  readonly id: string;
  readonly round_no: number;
  readonly payload: Record<string, unknown> | null;
}

interface ParticipantRow {
  readonly user_id: string;
  readonly seat: number;
  readonly entry_ap: number;
  readonly users?: { handle: string | null } | null;
}

interface ArgumentRow {
  readonly round_id: string;
  readonly user_id: string;
  readonly text: string;
}

interface VotingPendingProps {
  readonly verdictDeadline: string | null;
  readonly rounds: ReadonlyArray<RoundRow>;
  readonly participants: ReadonlyArray<ParticipantRow>;
  readonly argumentsList: ReadonlyArray<ArgumentRow>;
  readonly currentUserId: string;
}

export function VotingPending({
  verdictDeadline,
  rounds,
  participants,
  argumentsList,
  currentUserId,
}: VotingPendingProps): React.JSX.Element {
  const secondsLeft = useCountdown(verdictDeadline);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold text-text-primary">
          Verdict pending. Community is voting.
        </h2>
        <p className="text-sm text-text-secondary">
          The community decides. AI scores in parallel as advisory.
        </p>
      </header>

      {secondsLeft !== null ? (
        <RoundTimer totalSeconds={VOTE_WINDOW_S} secondsLeft={secondsLeft} />
      ) : null}

      <ArgumentsTimeline
        rounds={rounds}
        participants={participants}
        argumentsList={argumentsList}
        currentUserId={currentUserId}
      />
    </div>
  );
}
