// Client island for the live battle UI. Polls trpc.battles.getRound on
// a 1-second interval; the server-side runner emits one battle_rounds
// row every 12s, so this UI catches each round within a tick of its
// arrival without ever holding a long-poll.
//
// State machine:
//   loading      first getBattle hasn't returned yet
//   waiting      battle is live, no rounds emitted yet
//   answering    a round is on screen and the user hasn't answered
//   revealed     the user submitted; we show the correct answer until
//                the next round arrives
//   settled      battle status flipped to 'settled' — render BattleResult

'use client';

import { BattleResult, QuestionCard, RoundTimer, type BattleResultRow } from '@diktat/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { trpc } from '../../../../lib/trpc';

const ROUND_DURATION_S = 12;

interface RoundPayload {
  questionId?: string;
  prompt?: string;
  choices?: string[];
}

interface BattleClientProps {
  readonly battleId: string;
}

export function BattleClient({ battleId }: BattleClientProps): React.JSX.Element {
  const battleQuery = trpc.battles.getBattle.useQuery({ battleId });
  const [sinceRoundNo, setSinceRoundNo] = useState(-1);
  const roundQuery = trpc.battles.getRound.useQuery(
    { battleId, sinceRoundNo },
    {
      refetchInterval: 1_000,
      enabled: battleQuery.data?.status === 'live',
    },
  );
  const submitAnswer = trpc.battles.submitAnswer.useMutation();

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [revealedCorrectIndex, setRevealedCorrectIndex] = useState<number | null>(null);
  const lastRoundIdRef = useRef<string | null>(null);

  // When a new round arrives, reset the per-round UI state.
  useEffect(() => {
    const r = roundQuery.data?.round;
    if (!r) return;
    if (r.id !== lastRoundIdRef.current) {
      lastRoundIdRef.current = r.id;
      setSelectedIndex(null);
      setRevealedCorrectIndex(null);
      setSinceRoundNo(r.roundNo);
      // Bump the battle snapshot so settled state lands quickly when the
      // last round resolves.
      void battleQuery.refetch();
    }
  }, [roundQuery.data, battleQuery]);

  // Tick the timer locally — the server doesn't push a "Xs left" feed.
  const [secondsLeft, setSecondsLeft] = useState(ROUND_DURATION_S);
  useEffect(() => {
    const r = roundQuery.data?.round;
    if (!r) return;
    const startedAt = new Date(r.createdAt).getTime();
    function tick(): void {
      const elapsed = (Date.now() - startedAt) / 1_000;
      setSecondsLeft(Math.max(0, ROUND_DURATION_S - Math.floor(elapsed)));
    }
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [roundQuery.data]);

  const battle = battleQuery.data;
  const round = roundQuery.data?.round;

  const isPracticeMatch = useMemo(() => {
    return battle?.participants.some((p) => /^bot[_-]/i.test(p.userId)) ?? false;
  }, [battle?.participants]);

  if (battleQuery.isLoading || !battle) {
    return <Status text="Loading battle…" />;
  }

  if (battle.status === 'settled') {
    return (
      <BattleResult
        rows={mapResultRows(battle.participants)}
        winnerUserId={battle.winnerUserId ?? null}
        practiceMatch={isPracticeMatch}
        onClose={() => window.history.back()}
      />
    );
  }

  if (!round) {
    return <Status text="Waiting for the first round to drop…" />;
  }

  const payload = round.payload as RoundPayload;
  const prompt = payload.prompt ?? `Question ${round.roundNo + 1}`;
  const choices = payload.choices ?? ['A', 'B', 'C', 'D'];

  async function handleSelect(idx: number): Promise<void> {
    if (revealedCorrectIndex !== null || selectedIndex !== null) return;
    setSelectedIndex(idx);
    try {
      const result = await submitAnswer.mutateAsync({
        battleId,
        roundId: round!.id,
        chosenIndex: idx,
      });
      setRevealedCorrectIndex(result.correct ? idx : nextWrongIndexFallback(idx));
    } catch {
      // Allow retry — clear the optimistic selection.
      setSelectedIndex(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <RoundTimer totalSeconds={ROUND_DURATION_S} secondsLeft={secondsLeft} />
      <QuestionCard
        roundNo={round.roundNo}
        totalRounds={5}
        prompt={prompt}
        choices={choices}
        selectedIndex={selectedIndex}
        correctIndex={revealedCorrectIndex}
        practiceMatch={isPracticeMatch}
        onSelect={(idx) => {
          void handleSelect(idx);
        }}
      />
    </div>
  );
}

function Status({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center text-text-secondary">
      {text}
    </div>
  );
}

function mapResultRows(
  participants: ReadonlyArray<{ userId: string; seat: number }>,
): BattleResultRow[] {
  return participants.map((p) => ({
    userId: p.userId,
    handle: `seat ${p.seat + 1}`,
    correctCount: 0,
    totalLatencyMs: 0,
    isYou: false,
  }));
}

// Defensive fallback when the server flags incorrect — we don't know
// the *correct* index from submitAnswer's payload, so we leave the
// chosen one highlighted as wrong without claiming a different one as
// right. Future enhancement: have submitAnswer return correctIndex.
function nextWrongIndexFallback(chosen: number): number {
  return chosen;
}
