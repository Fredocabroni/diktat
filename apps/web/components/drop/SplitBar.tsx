// Post-vote split surface. Renders one of two layouts:
//
//   * early mode (total < 5): a single-line "you're early" note so no
//     one's vote is inferable. No bar, no percentages.
//   * full mode (total >= 5): a two-tone bar sized by percentage +
//     a one-line summary "62% agree · 38% disagree · 1,204 votes".
//
// Neutral by contract (addiction-auditor): no red/green, no tribe or
// winner tinting, no "you're in the minority" framing. Agree and
// disagree bars use the same neutral surface tones; the user's own
// stance is highlighted upstream on the stance buttons, not here.

'use client';

export type SplitState =
  | { readonly kind: 'early'; readonly total: number }
  | {
      readonly kind: 'full';
      readonly agreePct: number;
      readonly disagreePct: number;
      readonly total: number;
    };

export interface SplitBarProps {
  readonly split: SplitState;
}

function formatCount(n: number): string {
  // Thousands separator only. "1,204 votes". Avoids 'K' / 'M'
  // abbreviations — the exact count is a transparency contract with
  // the user; abbreviating reads as hiding.
  try {
    return new Intl.NumberFormat('en-US').format(n);
  } catch {
    return String(n);
  }
}

export function SplitBar({ split }: SplitBarProps): React.JSX.Element {
  if (split.kind === 'early') {
    return (
      <div
        data-component="SplitBar"
        data-variant="early"
        role="status"
        aria-live="polite"
        className="rounded-xl border border-ink-300 bg-surface-raised px-3 py-2 text-sm text-text-secondary"
      >
        <p>
          you&rsquo;re early. split shows at 5 votes.{' '}
          <span className="text-text-tertiary">{`(${formatCount(split.total)} so far.)`}</span>
        </p>
      </div>
    );
  }

  const voteLabel = split.total === 1 ? 'vote' : 'votes';
  return (
    <div
      data-component="SplitBar"
      data-variant="full"
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2"
    >
      <div
        role="img"
        aria-label={`${split.agreePct}% agree, ${split.disagreePct}% disagree`}
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface-raised"
      >
        <span
          data-component="SplitBar.AgreeFill"
          style={{ width: `${split.agreePct}%` }}
          className="block h-full bg-ink-700"
          aria-hidden
        />
        <span
          data-component="SplitBar.DisagreeFill"
          style={{ width: `${split.disagreePct}%` }}
          className="block h-full bg-ink-400"
          aria-hidden
        />
      </div>
      <p className="text-sm text-text-secondary">
        {`${split.agreePct}% agree · ${split.disagreePct}% disagree · ${formatCount(split.total)} ${voteLabel}`}
      </p>
    </div>
  );
}
