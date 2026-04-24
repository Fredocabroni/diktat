import * as React from 'react';

export interface SessionNudgeSheetProps {
  readonly open: boolean;
  readonly minutesElapsed: number;
  readonly onContinue: () => void;
  readonly onLater: () => void;
  readonly className?: string;
}

/**
 * The 30-minute session-length nudge sheet, per
 * `docs/ADDICTION_ARCHITECTURE.md` §12. The wording is the trust-up
 * framing — phrased as a check, not a wall. Two buttons: stay (5 more
 * minutes), or come back later (close the app).
 *
 * Visual primitive. The wrapper that tracks elapsed minutes via
 * `localStorage` and decides when to mount this lives in apps/web.
 */
export function SessionNudgeSheet(props: SessionNudgeSheetProps): React.ReactElement | null {
  const { open, minutesElapsed, onContinue, onLater, className } = props;

  const labelId = React.useId();

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      data-component="SessionNudgeSheet"
      className={className}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        background: 'rgba(8,8,12,0.6)',
        zIndex: 60,
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--color-surface-card, #1c1c1f)',
          color: 'var(--color-text-primary, #f2f2f7)',
          borderRadius: 24,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <h2
          id={labelId}
          style={{
            fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
            fontWeight: 700,
            fontSize: 20,
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          You&rsquo;ve been here {Math.round(minutesElapsed)} minutes. Want to take a break?
        </h2>
        <p
          style={{
            fontFamily: 'var(--font-sans, system-ui)',
            fontSize: 14,
            lineHeight: 1.5,
            margin: 0,
            color: 'var(--color-text-secondary, #c7c7cc)',
          }}
        >
          We&rsquo;d rather you come back tomorrow than burn out tonight.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <button
            type="button"
            onClick={onLater}
            data-action="later"
            style={{
              appearance: 'none',
              border: '1px solid var(--color-ink-300, rgba(255,255,255,0.18))',
              borderRadius: 16,
              padding: '14px 12px',
              background: 'transparent',
              color: 'var(--color-text-primary, #f2f2f7)',
              fontFamily: 'var(--font-sans, system-ui)',
              fontWeight: 600,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            I&rsquo;ll come back later
          </button>
          <button
            type="button"
            onClick={onContinue}
            data-action="continue"
            style={{
              appearance: 'none',
              border: 'none',
              borderRadius: 16,
              padding: '14px 12px',
              background: 'var(--color-accent-primary, #ff5ea5)',
              color: '#0b0612',
              fontFamily: 'var(--font-sans, system-ui)',
              fontWeight: 700,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            Just 5 more minutes
          </button>
        </div>
      </div>
    </div>
  );
}
