import * as React from 'react';

export interface SessionNudgeSheetProps {
  readonly open: boolean;
  readonly onContinue: () => void;
  readonly onLater: () => void;
  readonly className?: string;
}

/**
 * 30-minute session-length nudge per `docs/ADDICTION_ARCHITECTURE.md`
 * §12. Trust-up framing: a quiet check-in, never a wall.
 *
 * Design contract (P4 pre-launch batch):
 *   - **Never blocks content.** No full-screen backdrop, no
 *     `aria-modal`. The sheet is positioned above the bottom tab bar
 *     and the rest of the page remains interactive. A user who wants
 *     to keep reading past the nudge simply ignores it.
 *   - **One gentle, dismissible banner.** `role="dialog"` without
 *     modal semantics; an explicit "Keep going" button closes it
 *     with no state change, "Close for now" closes it AND signals
 *     the operator-recommended off-ramp.
 *   - **At most once per session.** The wrapper in apps/web uses
 *     sessionStorage so the banner fires exactly once per tab
 *     lifetime. No snooze loop — if the user picks "Keep going"
 *     the banner stays closed for the rest of the session.
 *   - **No urgency, no scarcity, no "come back tomorrow".** The
 *     body is a check-in, not a scare. The subtitle is intentionally
 *     omitted: the question + two buttons is the whole thing.
 */
export function SessionNudgeSheet(props: SessionNudgeSheetProps): React.ReactElement | null {
  const { open, onContinue, onLater, className } = props;

  const labelId = React.useId();

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-labelledby={labelId}
      data-component="SessionNudgeSheet"
      className={className}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 'calc(env(safe-area-inset-bottom) + 72px)',
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 40,
        padding: '0 16px',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          width: '100%',
          maxWidth: 480,
          background: 'var(--color-surface-card, #1c1c1f)',
          color: 'var(--color-text-primary, #f2f2f7)',
          borderRadius: 20,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          border: '1px solid var(--color-ink-300, rgba(255,255,255,0.14))',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <h2
          id={labelId}
          style={{
            fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
            fontWeight: 600,
            fontSize: 17,
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          You&rsquo;ve been here 30 minutes. Take a break?
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button
            type="button"
            onClick={onContinue}
            data-action="continue"
            style={{
              appearance: 'none',
              border: '1px solid var(--color-ink-300, rgba(255,255,255,0.18))',
              borderRadius: 14,
              padding: '12px 10px',
              background: 'transparent',
              color: 'var(--color-text-primary, #f2f2f7)',
              fontFamily: 'var(--font-sans, system-ui)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Keep going
          </button>
          <button
            type="button"
            onClick={onLater}
            data-action="later"
            style={{
              appearance: 'none',
              border: 'none',
              borderRadius: 14,
              padding: '12px 10px',
              background: 'var(--color-accent-primary, #ff5ea5)',
              color: '#0b0612',
              fontFamily: 'var(--font-sans, system-ui)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Close for now
          </button>
        </div>
      </div>
    </div>
  );
}
