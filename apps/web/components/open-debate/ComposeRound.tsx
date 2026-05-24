// Per-round compose surface. Blind submission -- the opponent's argument
// is RLS-hidden until both submit or the deadline passes. Two states
// rendered here:
//   - composing      textarea + char counter + submit
//   - submitted      read-only own text + "waiting for opponent"
// The submitted-waiting state branches inside this component because the
// header + countdown stay identical -- only the body changes.

'use client';

import { RoundTimer } from '@diktat/ui';
import { useEffect, useMemo, useState } from 'react';

import { trpc } from '../../lib/trpc';

const ARGUMENT_MIN = 100;
const ARGUMENT_MAX = 2000;
const ROUND_DURATION_S = 5 * 60;

const ROUND_LABELS: ReadonlyArray<string> = ['Opening', 'Rebuttal', 'Closing'];

function roundLabel(roundNo: number): string {
  return ROUND_LABELS[roundNo] ?? `Round ${roundNo + 1}`;
}

interface ComposeRoundProps {
  readonly roundId: string;
  readonly roundNo: number;
  readonly deadlineAt: string | null;
  /** The caller's already-submitted argument text, if any. When set, the
   *  read-only "submitted, waiting" state renders instead of the composer. */
  readonly existingText: string | null;
  readonly onMutationSettled: () => void;
}

export function ComposeRound({
  roundId,
  roundNo,
  deadlineAt,
  existingText,
  onMutationSettled,
}: ComposeRoundProps): React.JSX.Element {
  const [text, setText] = useState('');
  const submit = trpc.debates.submitArgument.useMutation({
    onSettled: () => onMutationSettled(),
  });
  const secondsLeft = useSecondsLeft(deadlineAt);

  const charCount = text.length;
  const tooShort = charCount < ARGUMENT_MIN;
  const tooLong = charCount > ARGUMENT_MAX;
  const counterColor = charCount >= 1900 ? 'text-danger' : 'text-text-secondary';

  const errorMessage = useMemo(() => {
    const err = submit.error;
    if (!err) return null;
    if (err.data?.code === 'CONFLICT') return 'You already submitted this round.';
    if (err.data?.code === 'BAD_REQUEST') return err.message;
    return 'Could not save argument. Try again.';
  }, [submit.error]);

  const header = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-display text-lg font-semibold text-text-primary">
        Round {roundNo + 1} of 3 — {roundLabel(roundNo)}
      </h2>
    </div>
  );

  const timer =
    secondsLeft !== null ? (
      <RoundTimer totalSeconds={ROUND_DURATION_S} secondsLeft={secondsLeft} />
    ) : null;

  if (existingText) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {timer}
        <div className="rounded-2xl border border-ink-300 bg-surface-card p-4">
          <p className="text-xs uppercase tracking-wide text-text-secondary">Your argument</p>
          <p className="mt-2 whitespace-pre-wrap text-text-primary">{existingText}</p>
        </div>
        <p className="text-center text-sm text-text-secondary">
          Submitted. Waiting for your opponent.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {header}
      {timer}
      <div className="rounded-2xl border border-ink-300 bg-surface-card p-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Make your case."
          maxLength={ARGUMENT_MAX}
          rows={10}
          className="w-full resize-none bg-transparent text-text-primary placeholder:text-text-secondary focus:outline-none"
          aria-label="Your argument"
        />
        <div className={`mt-2 text-right text-xs ${counterColor}`}>
          {charCount} / {ARGUMENT_MAX}
        </div>
      </div>
      <button
        type="button"
        disabled={tooShort || tooLong || submit.isPending}
        onClick={() => submit.mutate({ roundId, text })}
        className="w-full rounded-full bg-brand px-6 py-3 font-semibold text-brand-fg transition disabled:opacity-50"
      >
        {submit.isPending ? 'Submitting.' : 'Submit argument'}
      </button>
      {errorMessage ? <p className="text-sm text-danger">{errorMessage}</p> : null}
      {tooShort && charCount > 0 ? (
        <p className="text-xs text-text-secondary">At least {ARGUMENT_MIN} characters.</p>
      ) : null}
    </div>
  );
}

function useSecondsLeft(deadlineAt: string | null): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(() =>
    computeSecondsLeft(deadlineAt),
  );
  useEffect(() => {
    setSecondsLeft(computeSecondsLeft(deadlineAt));
    if (!deadlineAt) return;
    const id = window.setInterval(() => {
      setSecondsLeft(computeSecondsLeft(deadlineAt));
    }, 500);
    return () => window.clearInterval(id);
  }, [deadlineAt]);
  return secondsLeft;
}

function computeSecondsLeft(deadlineAt: string | null): number | null {
  if (!deadlineAt) return null;
  const ms = new Date(deadlineAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1000));
}
