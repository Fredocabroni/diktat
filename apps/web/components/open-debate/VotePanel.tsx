// Vote panel for non-participant observers during the verdict round's
// awaiting_final_vote window. Shows arguments first (caller reads, then
// decides), then a vote button per seat. After successful vote, the
// "you voted" state renders -- driven by debate_votes_select_own RLS
// (caller sees their own row even mid-window).

'use client';

import { RoundTimer } from '@diktat/ui';
import { useMemo } from 'react';

import { trpc } from '../../lib/trpc';

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

interface VoteRow {
  readonly voter_user_id: string;
  readonly vote_for_user_id: string;
  readonly ap_at_vote_time: number;
}

interface VotePanelProps {
  readonly battleId: string;
  readonly verdictDeadline: string | null;
  readonly rounds: ReadonlyArray<RoundRow>;
  readonly participants: ReadonlyArray<ParticipantRow>;
  readonly argumentsList: ReadonlyArray<ArgumentRow>;
  readonly votes: ReadonlyArray<VoteRow>;
  readonly currentUserId: string;
  readonly onMutationSettled: () => void;
}

export function VotePanel({
  battleId,
  verdictDeadline,
  rounds,
  participants,
  argumentsList,
  votes,
  currentUserId,
  onMutationSettled,
}: VotePanelProps): React.JSX.Element {
  const secondsLeft = useCountdown(verdictDeadline);
  const castVote = trpc.debates.castVote.useMutation({
    onSettled: () => onMutationSettled(),
  });

  const sortedSeats = useMemo(
    () => [...participants].sort((a, b) => a.seat - b.seat),
    [participants],
  );

  const myVote = votes.find((v) => v.voter_user_id === currentUserId);
  const votedFor = myVote ? participants.find((p) => p.user_id === myVote.vote_for_user_id) : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold text-text-primary">
          Vote — which argument was stronger?
        </h2>
        <p className="text-sm text-text-secondary">Your vote is weighted by your AP.</p>
      </header>

      {secondsLeft !== null ? (
        <RoundTimer totalSeconds={VOTE_WINDOW_S} secondsLeft={secondsLeft} />
      ) : null}

      {votedFor ? (
        <div className="rounded-2xl border border-brand bg-brand/10 p-4 text-center">
          <p className="font-display text-base font-semibold text-text-primary">
            Voted for @{votedFor.users?.handle ?? `seat ${votedFor.seat + 1}`}.
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            Weight: {myVote?.ap_at_vote_time ?? 0} AP
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sortedSeats.map((p) => {
            const handle = p.users?.handle ?? `seat ${p.seat + 1}`;
            return (
              <li key={p.user_id}>
                <button
                  type="button"
                  disabled={castVote.isPending}
                  onClick={() => castVote.mutate({ battleId, voteForUserId: p.user_id })}
                  className="w-full rounded-2xl border border-ink-300 bg-surface-card p-4 text-left transition hover:border-brand disabled:opacity-50"
                >
                  <p className="text-xs uppercase tracking-wide text-text-secondary">
                    Seat {p.seat + 1}
                  </p>
                  <p className="mt-1 font-display font-semibold text-text-primary">@{handle}</p>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {castVote.error ? <p className="text-sm text-danger">{castVote.error.message}</p> : null}

      <ArgumentsTimeline
        rounds={rounds}
        participants={participants}
        argumentsList={argumentsList}
        currentUserId={currentUserId}
      />
    </div>
  );
}
