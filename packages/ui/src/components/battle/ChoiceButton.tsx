import * as React from 'react';

export type ChoiceState = 'idle' | 'selected' | 'correct' | 'wrong';

export interface ChoiceButtonProps {
  readonly index: number;
  readonly label: string;
  readonly state?: ChoiceState;
  readonly disabled?: boolean;
  readonly onClick: (index: number) => void;
  readonly className?: string;
}

const LETTERS = ['A', 'B', 'C', 'D'];

export function ChoiceButton(props: ChoiceButtonProps): React.ReactElement {
  const { index, label, state = 'idle', disabled = false, onClick, className } = props;
  const palette = paletteFor(state);
  return (
    <button
      type="button"
      data-component="ChoiceButton"
      data-index={index}
      data-state={state}
      disabled={disabled}
      onClick={() => onClick(index)}
      aria-pressed={state === 'selected' || state === 'correct' || state === 'wrong'}
      className={className}
      style={{
        appearance: 'none',
        border: `2px solid ${palette.border}`,
        borderRadius: 16,
        padding: '14px 16px',
        background: palette.bg,
        color: palette.fg,
        fontFamily: 'var(--font-sans, system-ui)',
        fontWeight: 600,
        fontSize: 15,
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: '9999px',
          background: palette.badge,
          color: palette.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
        }}
      >
        {LETTERS[index] ?? String(index)}
      </span>
      <span>{label}</span>
    </button>
  );
}

function paletteFor(state: ChoiceState): {
  bg: string;
  fg: string;
  border: string;
  badge: string;
} {
  switch (state) {
    case 'correct':
      return {
        bg: 'var(--color-accent-success-bg, rgba(45,211,111,0.18))',
        fg: 'var(--color-text-primary, #f2f2f7)',
        border: 'var(--color-accent-success, #2dd36f)',
        badge: 'var(--color-accent-success, #2dd36f)',
      };
    case 'wrong':
      return {
        bg: 'var(--color-accent-danger-bg, rgba(255,69,58,0.18))',
        fg: 'var(--color-text-primary, #f2f2f7)',
        border: 'var(--color-accent-danger, #ff453a)',
        badge: 'var(--color-accent-danger, #ff453a)',
      };
    case 'selected':
      return {
        bg: 'var(--color-surface-elevated, #2a2a2e)',
        fg: 'var(--color-text-primary, #f2f2f7)',
        border: 'var(--color-accent-primary, #ff5ea5)',
        badge: 'var(--color-accent-primary, #ff5ea5)',
      };
    default:
      return {
        bg: 'var(--color-surface-card, #1c1c1f)',
        fg: 'var(--color-text-primary, #f2f2f7)',
        border: 'var(--color-ink-300, rgba(255,255,255,0.18))',
        badge: 'var(--color-surface-elevated, #2a2a2e)',
      };
  }
}
