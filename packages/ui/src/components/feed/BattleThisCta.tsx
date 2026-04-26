import * as React from 'react';

export interface BattleThisCtaProps {
  readonly topicId: string;
  readonly onClick: (topicId: string) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly className?: string;
}

/**
 * "Battle This" call-to-action. Visual primitive only — the wired feed
 * page (post PR #17) hooks `onClick` to `matchmaking.enqueue` with the
 * topic id as context. In the partial PR the click is a no-op.
 */
export function BattleThisCta(props: BattleThisCtaProps): React.ReactElement {
  const { topicId, onClick, disabled = false, label = 'Battle This', className } = props;

  return (
    <button
      type="button"
      data-component="BattleThisCta"
      data-topic-id={topicId}
      disabled={disabled}
      onClick={() => onClick(topicId)}
      className={className}
      style={{
        appearance: 'none',
        border: 'none',
        borderRadius: 999,
        padding: '14px 20px',
        fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: 0.2,
        background:
          'linear-gradient(135deg, var(--color-accent-primary, #ff5ea5) 0%, var(--color-accent-secondary, #6c5cff) 100%)',
        color: '#0b0612',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        boxShadow: '0 6px 18px rgba(108,92,255,0.35)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span aria-hidden>⚔️</span>
      <span>{label}</span>
    </button>
  );
}
