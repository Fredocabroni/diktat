// Route-level skeleton for the (app) shell. Shows while a tab's server
// segment resolves (the layout's auth + RPC, then the page). Mirrors the
// top-of-feed shape inside the house max-w-md column and respects the
// safe-area top inset the shell's <main> uses.

export default function AppLoading(): React.JSX.Element {
  return (
    <div
      className="mx-auto max-w-md px-4 pt-[calc(env(safe-area-inset-top)+24px)]"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading…</span>
      <div className="animate-pulse space-y-4">
        {/* Header line */}
        <div className="h-7 w-40 rounded-lg bg-ink-300" />
        <div className="h-4 w-56 rounded bg-ink-200" />
        {/* Feed cards */}
        <div className="space-y-4 pt-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-surface-card p-5">
              <div className="h-4 w-24 rounded bg-ink-300" />
              <div className="mt-4 h-5 w-full rounded bg-ink-200" />
              <div className="mt-2 h-5 w-4/5 rounded bg-ink-200" />
              <div className="mt-6 flex gap-3">
                <div className="h-11 flex-1 rounded-xl bg-ink-300" />
                <div className="h-11 flex-1 rounded-xl bg-ink-300" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
