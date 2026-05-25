// Round reveal view. Both arguments laid out top-to-bottom (mobile-
// first; max-w-md is too narrow for side-by-side text blocks at any
// realistic length). Forfeit badge sits on the seat whose user_id is
// in payload.forfeit_seats.

'use client';

import { useMemo } from 'react';

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
  readonly submitted_at: string;
}

interface RevealRoundProps {
  readonly roundNo: number;
  readonly roundId: string;
  readonly payload: Record<string, unknown> | null;
  readonly participants: ReadonlyArray<ParticipantRow>;
  readonly argumentsList: ReadonlyArray<ArgumentRow>;
  readonly currentUserId: string;
}

const ROUND_LABELS: ReadonlyArray<string> = ['Opening', 'Rebuttal', 'Closing'];

export function RevealRound({
  roundNo,
  roundId,
  payload,
  participants,
  argumentsList,
  currentUserId,
}: RevealRoundProps): React.JSX.Element {
  const sortedSeats = useMemo(
    () => [...participants].sort((a, b) => a.seat - b.seat),
    [participants],
  );

  const forfeitSeats = readForfeitSeats(payload);
  const revealedBy = readRevealedBy(payload);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold text-text-primary">
          Round {roundNo + 1} of 3 — {ROUND_LABELS[roundNo] ?? `Round ${roundNo + 1}`}
        </h2>
        <p className="text-xs uppercase tracking-wide text-text-secondary">
          {revealedBy === 'both_submitted' ? 'Both submitted' : 'Time expired'}
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {sortedSeats.map((p) => {
          const arg = argumentsList.find((a) => a.round_id === roundId && a.user_id === p.user_id);
          const handle = p.users?.handle ?? `seat ${p.seat + 1}`;
          const isForfeit = forfeitSeats.includes(p.seat);
          const isYou = p.user_id === currentUserId;
          return (
            <li
              key={p.user_id}
              className={`rounded-2xl border bg-surface-card p-4 ${
                isYou ? 'border-brand' : 'border-ink-300'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-wide text-text-secondary">
                  Seat {p.seat + 1} {isYou ? '· you' : ''}
                </p>
                <p className="text-xs text-text-secondary">
                  @{handle} · {p.entry_ap} AP
                </p>
              </div>
              {isForfeit ? (
                <div className="mt-3 rounded-lg border border-ink-300 bg-surface-app p-3 text-center text-sm text-text-secondary">
                  Forfeit (deadline)
                </div>
              ) : (
                <p className="mt-3 whitespace-pre-wrap text-text-primary">{arg?.text ?? '—'}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function readForfeitSeats(payload: Record<string, unknown> | null | undefined): number[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { forfeit_seats?: unknown }).forfeit_seats;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number');
}

function readRevealedBy(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  const v = (payload as { revealed_by?: unknown }).revealed_by;
  return typeof v === 'string' ? v : '';
}
