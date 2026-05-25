// Verdict card. Four branches on (decided_by, disagreement, ai availability):
//
//   1. community_ap + !disagreement  → "COMMUNITY DECIDED"
//      Winner large; tally inline; AI agreement panel below (small,
//      bordered, AI reason verbatim).
//   2. community_ap + disagreement   → "COMMUNITY DECIDED · AI DISSENTED"
//      Same hierarchy as (1) -- community is the record. AI dissent
//      panel below with violet border on the community block and
//      accent border on the AI block. AI reason verbatim, never
//      paraphrased.
//   3. ai_tiebreaker                  → "COMMUNITY SPLIT · AI BROKE TIE"
//      Winner large (AI's pick); community tally shows the split;
//      AI tiebreak panel with reason.
//   4. unresolved                     → "NO DECISION"
//      Zero votes + AI couldn't score. No AP change. No AI panel.
//
// The §2 fairness contract: the community is decisive on AP, but the
// AI's reasoning is shown fully so a user who lost a vote can see
// exactly why the AI disagreed (or agreed). The visual hierarchy
// makes the community result unmistakably the record while keeping
// the AI fully visible as advisory.

'use client';

import { useMemo } from 'react';

import { ArgumentsTimeline } from './ArgumentsTimeline';

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

interface VerdictCardProps {
  readonly verdictRound: RoundRow | null;
  readonly rounds: ReadonlyArray<RoundRow>;
  readonly participants: ReadonlyArray<ParticipantRow>;
  readonly argumentsList: ReadonlyArray<ArgumentRow>;
  readonly currentUserId: string;
}

interface VerdictPayload {
  readonly ai: {
    readonly winnerSeat?: number | null;
    readonly scoreA?: number;
    readonly scoreB?: number;
    readonly reason?: string;
    readonly error?: string;
  } | null;
  readonly community: {
    readonly ap_for_seat_0: number;
    readonly ap_for_seat_1: number;
    readonly voter_count: number;
  } | null;
  readonly decided_by: 'community_ap' | 'ai_tiebreaker' | 'unresolved' | null;
  readonly disagreement: boolean;
  readonly winner_seat: number | null;
  readonly winner_user_id: string | null;
}

export function VerdictCard({
  verdictRound,
  rounds,
  participants,
  argumentsList,
  currentUserId,
}: VerdictCardProps): React.JSX.Element {
  const v = useMemo(() => parseVerdictPayload(verdictRound?.payload), [verdictRound]);

  const seatOf = (userId: string | null): ParticipantRow | null =>
    userId ? (participants.find((p) => p.user_id === userId) ?? null) : null;
  const bySeat = (seat: number | null): ParticipantRow | null =>
    seat === null ? null : (participants.find((p) => p.seat === seat) ?? null);

  const winner = v ? seatOf(v.winner_user_id) : null;
  const aiHasOpinion = v?.ai != null && !v.ai.error && typeof v.ai.winnerSeat === 'number';
  const aiPick = aiHasOpinion ? bySeat(v?.ai?.winnerSeat ?? null) : null;

  const decision = v?.decided_by ?? 'unresolved';
  const isDisagreement = !!v?.disagreement;

  return (
    <div className="flex flex-col gap-4">
      {/* Headline label */}
      <p className="text-center text-xs uppercase tracking-wide text-text-secondary">
        {headlineLabel(decision, isDisagreement)}
      </p>

      {/* Winner block (when a winner exists) */}
      {winner ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-brand bg-brand/5 p-6 text-center">
          <p className="font-display text-2xl font-bold text-text-primary">
            @{winner.users?.handle ?? `seat ${winner.seat + 1}`}
          </p>
          <p className="text-sm text-text-secondary">wins the debate</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center">
          <p className="font-display text-xl font-semibold text-text-primary">No decision</p>
          <p className="mt-2 text-sm text-text-secondary">
            Zero community votes and AI could not score. No AP change.
          </p>
        </div>
      )}

      {/* Community tally (primary fact, when a community result exists) */}
      {v?.community && (decision === 'community_ap' || decision === 'ai_tiebreaker') ? (
        <CommunityTally community={v.community} decision={decision} participants={participants} />
      ) : null}

      {/* AI panel (when AI weighed in) */}
      {aiHasOpinion && aiPick && v?.ai ? (
        <AiPanel
          variant={
            decision === 'ai_tiebreaker' ? 'tiebreaker' : isDisagreement ? 'dissent' : 'agreement'
          }
          aiPick={aiPick}
          scoreA={v.ai.scoreA ?? 0}
          scoreB={v.ai.scoreB ?? 0}
          reason={v.ai.reason ?? ''}
        />
      ) : decision !== 'unresolved' && v?.ai?.error ? (
        <p className="rounded-2xl border border-ink-300 bg-surface-card p-4 text-center text-xs text-text-secondary">
          AI could not score this debate.
        </p>
      ) : null}

      {/* Arguments timeline */}
      <ArgumentsTimeline
        rounds={rounds}
        participants={participants}
        argumentsList={argumentsList}
        currentUserId={currentUserId}
      />
    </div>
  );
}

function CommunityTally({
  community,
  decision,
  participants,
}: {
  readonly community: { ap_for_seat_0: number; ap_for_seat_1: number; voter_count: number };
  readonly decision: 'community_ap' | 'ai_tiebreaker';
  readonly participants: ReadonlyArray<ParticipantRow>;
}): React.JSX.Element {
  const seat0 = participants.find((p) => p.seat === 0);
  const seat1 = participants.find((p) => p.seat === 1);
  const handle0 = seat0?.users?.handle ?? 'seat 1';
  const handle1 = seat1?.users?.handle ?? 'seat 2';
  const total = community.ap_for_seat_0 + community.ap_for_seat_1;
  return (
    <div className="rounded-2xl border border-ink-300 bg-surface-card p-4 text-center">
      <p className="text-xs uppercase tracking-wide text-text-secondary">
        Community {decision === 'ai_tiebreaker' ? 'split' : 'tally'}
      </p>
      <p className="mt-2 text-sm text-text-primary">
        @{handle0}: {community.ap_for_seat_0} AP · @{handle1}: {community.ap_for_seat_1} AP
      </p>
      <p className="mt-1 text-xs text-text-secondary">
        {community.voter_count} {community.voter_count === 1 ? 'voter' : 'voters'} · {total} AP
        weighted
      </p>
    </div>
  );
}

function AiPanel({
  variant,
  aiPick,
  scoreA,
  scoreB,
  reason,
}: {
  readonly variant: 'agreement' | 'dissent' | 'tiebreaker';
  readonly aiPick: ParticipantRow;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly reason: string;
}): React.JSX.Element {
  const handle = aiPick.users?.handle ?? `seat ${aiPick.seat + 1}`;
  const label =
    variant === 'dissent'
      ? 'AI dissent · advisory only'
      : variant === 'tiebreaker'
        ? 'AI tiebreaker'
        : 'AI agreed · advisory';
  const verb = variant === 'tiebreaker' ? 'awarded it to' : 'picked';
  return (
    <div className="rounded-2xl border border-brand-accent bg-surface-card p-4">
      <p className="text-xs uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-2 text-sm text-text-primary">
        AI {verb} @{handle}. Score: {scoreA} vs {scoreB}.
      </p>
      {reason ? (
        <blockquote className="mt-3 border-l-2 border-ink-300 pl-3 text-sm text-text-secondary">
          {reason}
        </blockquote>
      ) : null}
    </div>
  );
}

function headlineLabel(
  decision: 'community_ap' | 'ai_tiebreaker' | 'unresolved',
  disagreement: boolean,
): string {
  if (decision === 'community_ap') {
    return disagreement ? 'Community decided · AI dissented' : 'Community decided';
  }
  if (decision === 'ai_tiebreaker') return 'Community split · AI broke tie';
  return 'No decision';
}

function parseVerdictPayload(
  payload: Record<string, unknown> | null | undefined,
): VerdictPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  return {
    ai: readAi(p.ai),
    community: readCommunity(p.community),
    decided_by: readDecidedBy(p.decided_by),
    disagreement: p.disagreement === true,
    winner_seat: typeof p.winner_seat === 'number' ? p.winner_seat : null,
    winner_user_id: typeof p.winner_user_id === 'string' ? p.winner_user_id : null,
  };
}

function readAi(v: unknown): VerdictPayload['ai'] {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  return {
    winnerSeat:
      typeof obj.winnerSeat === 'number'
        ? obj.winnerSeat
        : obj.winnerSeat === null
          ? null
          : undefined,
    scoreA: typeof obj.scoreA === 'number' ? obj.scoreA : undefined,
    scoreB: typeof obj.scoreB === 'number' ? obj.scoreB : undefined,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

function readCommunity(v: unknown): VerdictPayload['community'] {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  return {
    ap_for_seat_0: typeof obj.ap_for_seat_0 === 'number' ? obj.ap_for_seat_0 : 0,
    ap_for_seat_1: typeof obj.ap_for_seat_1 === 'number' ? obj.ap_for_seat_1 : 0,
    voter_count: typeof obj.voter_count === 'number' ? obj.voter_count : 0,
  };
}

function readDecidedBy(v: unknown): VerdictPayload['decided_by'] {
  if (v === 'community_ap' || v === 'ai_tiebreaker' || v === 'unresolved') return v;
  return null;
}
