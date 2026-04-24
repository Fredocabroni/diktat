import * as React from 'react';

export type OpinionPosition = -2 | -1 | 0 | 1 | 2;

export interface OpinionSliderProps {
  readonly value: OpinionPosition;
  readonly onChange: (next: OpinionPosition) => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly className?: string;
}

const LABELS: Record<OpinionPosition, string> = {
  [-2]: 'Strongly disagree',
  [-1]: 'Disagree',
  [0]: 'Neutral',
  [1]: 'Agree',
  [2]: 'Strongly agree',
};

/**
 * Five-step opinion slider (-2..+2). Wraps a native HTML range input so
 * keyboard, touch, and screen-reader semantics come for free. Writes
 * land in `opinion_shifts` via the feed router.
 */
export function OpinionSlider(props: OpinionSliderProps): React.ReactElement {
  const { value, onChange, disabled = false, ariaLabel = 'Your opinion', className } = props;

  return (
    <div
      data-component="OpinionSlider"
      data-value={value}
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <input
        type="range"
        min={-2}
        max={2}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={LABELS[value]}
        onChange={(event) => {
          const next = Number(event.target.value) as OpinionPosition;
          onChange(next);
        }}
        style={{ width: '100%' }}
      />
      <div
        aria-hidden
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          fontFamily: 'var(--font-sans, system-ui)',
          fontSize: 11,
          color: 'var(--color-text-secondary, #c7c7cc)',
        }}
      >
        {([-2, -1, 0, 1, 2] as const).map((p) => (
          <span
            key={p}
            style={{
              textAlign: p === -2 ? 'left' : p === 2 ? 'right' : 'center',
              fontWeight: p === value ? 700 : 400,
              color:
                p === value
                  ? 'var(--color-text-primary, #f2f2f7)'
                  : 'var(--color-text-secondary, #c7c7cc)',
            }}
          >
            {LABELS[p]}
          </span>
        ))}
      </div>
    </div>
  );
}
