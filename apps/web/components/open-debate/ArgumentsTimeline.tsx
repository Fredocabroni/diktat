// Scrollable timeline of all revealed argument rounds (round_no 0/1/2).
// Used by VotePanel, VotingPending, and the post-settle verdict screen.
// Hides rounds still in `awaiting_arguments` because per-seat blind
// submissions are RLS-filtered to the author until reveal -- showing a
// half-redacted card would be more confusing than just hiding it.

'use client';

import { useMemo } from 'react';

const ROUND_LABELS: ReadonlyArray<string> = ['Opening', 'Rebuttal', 'Closing'];

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

interface ArgumentsTimelineProps {
  readonly rounds: ReadonlyArray<RoundRow>;
  readonly participants: ReadonlyArray<ParticipantRow>;
  readonly argumentsList: ReadonlyArray<ArgumentRow>;
  readonly currentUserId: string;
}

export function ArgumentsTimeline({
  rounds,
  participants,
  argumentsList,
  currentUserId,
}: ArgumentsTimelineProps): React.JSX.Element {
  const sortedSeats = useMemo(
    () => [...participants].sort((a, b) => a.seat - b.seat),
    [participants],
  );

  const revealedArgRounds = useMemo(
    () => rounds.filter((r) => r.round_no < 3 && stateOf(r.payload) !== 'awaiting_arguments'),
    [rounds],
  );

  if (revealedArgRounds.length === 0) {
    return (
      <p className="rounded-2xl border border-ink-300 bg-surface-card p-4 text-center text-sm text-text-secondary">
        Arguments reveal when both submit or the deadline passes.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-4">
      {revealedArgRounds.map((round) => {
        const forfeitSeats = readForfeitSeats(round.payload);
        return (
          <li key={round.id} className="flex flex-col gap-2">
            <p className="text-xs uppercase tracking-wide text-text-secondary">
              Round {round.round_no + 1} — {ROUND_LABELS[round.round_no] ?? ''}
            </p>
            <div className="flex flex-col gap-2">
              {sortedSeats.map((p) => {
                const arg = argumentsList.find(
                  (a) => a.round_id === round.id && a.user_id === p.user_id,
                );
                const handle = p.users?.handle ?? `seat ${p.seat + 1}`;
                const isYou = p.user_id === currentUserId;
                const isForfeit = forfeitSeats.includes(p.seat);
                return (
                  <div
                    key={p.user_id}
                    className={`rounded-xl border bg-surface-card p-3 ${
                      isYou ? 'border-brand' : 'border-ink-300'
                    }`}
                  >
                    <p className="text-xs text-text-secondary">
                      Seat {p.seat + 1}
                      {isYou ? ' · you' : ''} · @{handle}
                    </p>
                    {isForfeit ? (
                      <p className="mt-2 text-sm text-text-secondary">Forfeit (deadline)</p>
                    ) : (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-text-primary">
                        {arg?.text ?? '—'}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function stateOf(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  const v = (payload as { state?: unknown }).state;
  return typeof v === 'string' ? v : '';
}

function readForfeitSeats(payload: Record<string, unknown> | null | undefined): number[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { forfeit_seats?: unknown }).forfeit_seats;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number');
}
