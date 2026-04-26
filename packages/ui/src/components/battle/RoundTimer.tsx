import * as React from 'react';

export interface RoundTimerProps {
  /** Total seconds the round runs for. */
  readonly totalSeconds: number;
  /** Seconds remaining. Caller drives this; the component is presentational. */
  readonly secondsLeft: number;
  readonly className?: string;
}

/**
 * Round countdown — a horizontal bar that drains from full to empty
 * with a numeric "Xs left" caption. Component is pure and presentational;
 * the caller owns the timer state so polling-driven battle pages stay
 * in control of when the visual ticks.
 */
export function RoundTimer(props: RoundTimerProps): React.ReactElement {
  const { totalSeconds, secondsLeft, className } = props;
  const clamped = Math.max(0, Math.min(totalSeconds, secondsLeft));
  const fraction = totalSeconds <= 0 ? 0 : clamped / totalSeconds;
  const widthPct = Math.round(fraction * 100);
  const danger = clamped <= 3 && totalSeconds >= 6;

  return (
    <div
      data-component="RoundTimer"
      data-seconds-left={clamped}
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={totalSeconds}
        aria-valuenow={clamped}
        aria-valuetext={`${clamped} seconds left`}
        style={{
          height: 6,
          borderRadius: 999,
          background: 'var(--color-surface-elevated, #2a2a2e)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${widthPct}%`,
            height: '100%',
            background: danger
              ? 'var(--color-accent-danger, #ff453a)'
              : 'var(--color-accent-primary, #ff5ea5)',
            transition: 'width 250ms linear, background 200ms ease-out',
          }}
        />
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
          fontSize: 12,
          color: 'var(--color-text-secondary, #c7c7cc)',
        }}
      >
        {clamped}s left
      </div>
    </div>
  );
}
