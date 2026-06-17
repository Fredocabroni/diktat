// §12 disclosure — rendered above the Drop card when the row's
// is_block_exhausted=true. Closes ADDICTION §12 ("Do You Trust Us?")
// for the case where every active cluster has run for 3 consecutive
// days and the pipeline recycled rather than skip a day (§5 "Never
// skip a day" wins). The user sees the same story cluster again;
// the banner discloses why rather than presenting it as fresh.

interface BlockExhaustedBannerProps {
  readonly className?: string;
}

export function BlockExhaustedBanner({ className }: BlockExhaustedBannerProps): React.JSX.Element {
  return (
    <div
      role="note"
      data-component="BlockExhaustedBanner"
      className={`rounded-2xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning-soft-fg ${className ?? ''}`}
    >
      <p className="font-display font-semibold">Slow news week.</p>
      <p className="mt-1">Today&rsquo;s Drop revisits an ongoing story.</p>
    </div>
  );
}
