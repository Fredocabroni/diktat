// Skeleton for the /battles list while its dynamic server segment fetches.
// A few card rows standing in for the battle list, in the house column.

export default function BattlesLoading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md px-4 py-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading battles…</span>
      <div className="animate-pulse">
        <div className="h-7 w-32 rounded-lg bg-ink-300" />
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 rounded-2xl bg-surface-card p-4">
              <div className="h-12 w-12 shrink-0 rounded-full bg-ink-300" />
              <div className="flex-1">
                <div className="h-4 w-3/4 rounded bg-ink-200" />
                <div className="mt-2 h-3 w-1/2 rounded bg-ink-200" />
              </div>
              <div className="h-9 w-16 shrink-0 rounded-xl bg-ink-300" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
