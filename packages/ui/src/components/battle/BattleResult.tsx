import * as React from 'react';

export interface BattleResultRow {
  readonly userId: string;
  readonly handle: string;
  readonly correctCount: number;
  readonly totalLatencyMs: number;
  readonly isYou: boolean;
  readonly isBot?: boolean;
}

export interface BattleResultProps {
  readonly rows: readonly BattleResultRow[];
  readonly winnerUserId: string | null;
  readonly apDelta?: number | null;
  readonly practiceMatch?: boolean;
  readonly onPlayAgain?: () => void;
  readonly onClose?: () => void;
  readonly className?: string;
}

export function BattleResult(props: BattleResultProps): React.ReactElement {
  const {
    rows,
    winnerUserId,
    apDelta = null,
    practiceMatch = false,
    onPlayAgain,
    onClose,
    className,
  } = props;

  const youRow = rows.find((r) => r.isYou);
  const youWon = youRow !== undefined && winnerUserId === youRow.userId;

  return (
    <article
      role="article"
      data-component="BattleResult"
      data-outcome={youWon ? 'win' : 'loss'}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        padding: 28,
        borderRadius: 24,
        background: 'var(--color-surface-card, #1c1c1f)',
        color: 'var(--color-text-primary, #f2f2f7)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
            fontSize: 12,
            color: 'var(--color-text-secondary, #c7c7cc)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
          }}
        >
          {practiceMatch ? 'Practice match' : 'Trivia battle'}
        </span>
        <h2
          style={{
            fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
            fontWeight: 700,
            fontSize: 26,
            margin: 0,
          }}
        >
          {youWon ? 'You won.' : 'You lost.'}
        </h2>
        {apDelta !== null ? (
          <p
            style={{
              fontFamily: 'var(--font-sans, system-ui)',
              fontSize: 15,
              margin: 0,
              color: 'var(--color-text-secondary, #c7c7cc)',
            }}
          >
            {apDelta >= 0 ? '+' : ''}
            {apDelta} AP{practiceMatch ? ' (practice — capped at 200/day)' : ''}
          </p>
        ) : null}
      </header>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.userId}
            data-row-user-id={row.userId}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              alignItems: 'center',
              gap: 16,
              padding: '12px 16px',
              borderRadius: 16,
              background:
                winnerUserId === row.userId
                  ? 'var(--color-accent-success-bg, rgba(45,211,111,0.18))'
                  : 'var(--color-surface-elevated, #2a2a2e)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong
                style={{
                  fontFamily: 'var(--font-sans, system-ui)',
                  fontWeight: 700,
                  fontSize: 15,
                }}
              >
                {row.handle}
                {row.isYou ? ' (you)' : ''}
              </strong>
              {row.isBot ? (
                <span
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
                    fontSize: 10,
                    color: 'var(--color-text-secondary, #c7c7cc)',
                    border: '1px solid var(--color-ink-300, rgba(255,255,255,0.18))',
                    borderRadius: 999,
                    padding: '2px 8px',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  bot
                </span>
              ) : null}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
                fontSize: 13,
                color: 'var(--color-text-secondary, #c7c7cc)',
              }}
            >
              {row.correctCount} correct
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
                fontSize: 13,
                color: 'var(--color-text-secondary, #c7c7cc)',
              }}
            >
              {(row.totalLatencyMs / 1000).toFixed(1)}s
            </span>
          </div>
        ))}
      </div>
      {onPlayAgain || onClose ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
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
              Close
            </button>
          ) : null}
          {onPlayAgain ? (
            <button
              type="button"
              onClick={onPlayAgain}
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
              Play again
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
