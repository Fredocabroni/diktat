import * as React from 'react';

import { ChoiceButton, type ChoiceState } from './ChoiceButton.js';

export interface QuestionCardProps {
  readonly roundNo: number;
  readonly totalRounds: number;
  readonly prompt: string;
  readonly choices: readonly string[];
  /** Currently selected index, if any. Caller owns the value. */
  readonly selectedIndex?: number | null;
  /** Index the server graded as correct, when results are revealed. */
  readonly correctIndex?: number | null;
  readonly disabled?: boolean;
  readonly practiceMatch?: boolean;
  readonly onSelect: (index: number) => void;
  readonly className?: string;
}

/**
 * Visual primitive for one battle round. Renders the prompt, four
 * ChoiceButton slots, and an optional "Practice match — bot opponent"
 * disclosure badge per ADDICTION_ARCHITECTURE.md §11 honesty.
 */
export function QuestionCard(props: QuestionCardProps): React.ReactElement {
  const {
    roundNo,
    totalRounds,
    prompt,
    choices,
    selectedIndex = null,
    correctIndex = null,
    disabled = false,
    practiceMatch = false,
    onSelect,
    className,
  } = props;

  return (
    <article
      role="article"
      data-component="QuestionCard"
      data-round-no={roundNo}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 24,
        borderRadius: 24,
        background: 'var(--color-surface-card, #1c1c1f)',
        color: 'var(--color-text-primary, #f2f2f7)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
            fontSize: 12,
            color: 'var(--color-text-secondary, #c7c7cc)',
          }}
        >
          Round {roundNo + 1} / {totalRounds}
        </span>
        {practiceMatch ? (
          <span
            data-slot="practice-badge"
            aria-label="Practice match against a bot opponent"
            style={{
              fontFamily: 'var(--font-sans, system-ui)',
              fontSize: 11,
              fontWeight: 700,
              padding: '4px 10px',
              borderRadius: 999,
              background: 'var(--color-surface-elevated, #2a2a2e)',
              color: 'var(--color-text-secondary, #c7c7cc)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Practice · bot opponent
          </span>
        ) : null}
      </header>
      <h2
        style={{
          fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
          fontWeight: 700,
          fontSize: 22,
          margin: 0,
          lineHeight: 1.3,
        }}
      >
        {prompt}
      </h2>
      <div style={{ display: 'grid', gap: 12 }}>
        {choices.map((label, idx) => (
          <ChoiceButton
            key={idx}
            index={idx}
            label={label}
            state={stateFor({ index: idx, selectedIndex, correctIndex })}
            disabled={disabled || correctIndex !== null}
            onClick={onSelect}
          />
        ))}
      </div>
    </article>
  );
}

function stateFor(opts: {
  index: number;
  selectedIndex: number | null;
  correctIndex: number | null;
}): ChoiceState {
  if (opts.correctIndex !== null) {
    if (opts.index === opts.correctIndex) return 'correct';
    if (opts.index === opts.selectedIndex) return 'wrong';
    return 'idle';
  }
  if (opts.index === opts.selectedIndex) return 'selected';
  return 'idle';
}
