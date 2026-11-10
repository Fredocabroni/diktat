// Collapsed topic card. Rendered in place of the full DropCard when
// the user taps Skip on the feed. One slim row:
//
//   <headline, truncated> · skipped · undo
//
// Tapping "undo" restores the full card at its position — any locked
// vote / split / choose state is preserved by the parent, this
// component is a pure render switch.
//
// Lowercase tonal copy ("skipped", "undo") to match the voice guide.
// No celebration, no "all caught up" copy anywhere in this surface.

'use client';

export interface SkippedCardProps {
  readonly topicId: string;
  readonly headline: string;
  readonly onUndo: () => void;
}

export function SkippedCard({ topicId, headline, onUndo }: SkippedCardProps): React.JSX.Element {
  return (
    <div
      data-component="SkippedCard"
      data-topic-id={topicId}
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-xl border border-ink-300 bg-surface-raised px-3 py-2 text-sm text-text-secondary"
    >
      <span
        data-component="SkippedCard.Headline"
        className="min-w-0 flex-1 truncate"
        title={headline}
      >
        {headline}
      </span>
      <span aria-hidden className="text-text-tertiary">
        ·
      </span>
      <span className="text-text-tertiary">skipped</span>
      <span aria-hidden className="text-text-tertiary">
        ·
      </span>
      <button
        type="button"
        data-component="SkippedCard.UndoButton"
        onClick={onUndo}
        className="underline underline-offset-2 hover:text-text-primary"
      >
        undo
      </button>
    </div>
  );
}
