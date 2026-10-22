// Content-report affordance. Small text link under reportable content;
// on click, a short inline panel opens with a reason textarea + Submit
// + Cancel. On success, the panel closes and a factual confirmation
// replaces the button for ~5 seconds.
//
// Operator contract (compliance batch): plain copy, no "help us keep
// the community safe" nudge, no post-submission guilt. The reason box
// is required; the server trims + length-caps.

'use client';

import { useState } from 'react';

import { trpc } from '../../lib/trpc';

type Phase = 'idle' | 'open' | 'submitting' | 'done' | 'error';

export interface ReportButtonProps {
  readonly targetType: 'debate_arg' | 'debate_post' | 'drop' | 'user';
  readonly targetId: string;
}

export function ReportButton(props: ReportButtonProps): React.JSX.Element {
  const { targetType, targetId } = props;
  const [phase, setPhase] = useState<Phase>('idle');
  const [reason, setReason] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const submit = trpc.reports.submit.useMutation();

  async function onSubmit(): Promise<void> {
    if (reason.trim().length === 0) {
      setErrorMsg('Say what you are reporting.');
      return;
    }
    setPhase('submitting');
    setErrorMsg(null);
    try {
      await submit.mutateAsync({ targetType, targetId, reason });
      setReason('');
      setPhase('done');
      // Auto-return to idle after a short beat so the thread stays
      // uncluttered — the confirmation is informational, not a trophy.
      setTimeout(() => setPhase('idle'), 5000);
    } catch (err) {
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : 'Report could not be saved. Try again.');
    }
  }

  if (phase === 'done') {
    return (
      <p
        role="status"
        aria-live="polite"
        data-component="ReportButton.Done"
        className="mt-2 text-xs text-text-tertiary"
      >
        Report sent.
      </p>
    );
  }

  if (phase === 'open' || phase === 'submitting' || phase === 'error') {
    return (
      <div
        data-component="ReportButton.Panel"
        className="mt-2 flex flex-col gap-2 rounded-lg border border-ink-300 bg-surface-shell p-3"
      >
        <label className="text-xs text-text-secondary">
          Why are you reporting this?
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            data-component="ReportButton.Reason"
            className="mt-1 w-full rounded-md border border-ink-300 bg-surface-card px-2 py-1 text-sm text-text-primary"
            rows={3}
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={phase === 'submitting'}
            data-component="ReportButton.Submit"
            className="rounded-full bg-brand-accent px-3 py-1 text-xs font-semibold text-brand-accent-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {phase === 'submitting' ? 'Sending…' : 'Submit'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPhase('idle');
              setErrorMsg(null);
            }}
            data-component="ReportButton.Cancel"
            className="rounded-full border border-ink-400 px-3 py-1 text-xs font-semibold text-text-secondary"
          >
            Cancel
          </button>
        </div>
        {errorMsg ? (
          <p role="alert" className="text-xs text-danger-soft-fg">
            {errorMsg}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setErrorMsg(null);
        setPhase('open');
      }}
      data-component="ReportButton.Start"
      className="mt-2 text-xs text-text-tertiary underline-offset-4 hover:text-text-secondary hover:underline"
    >
      Report
    </button>
  );
}
