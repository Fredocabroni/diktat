// Skeleton for a single battle while the page's two server round-trips
// (auth.getUser + the battles row lookup) resolve before any client island
// mounts. Card shape mirrors the battle-detail section container.

export default function BattleDetailLoading(): React.JSX.Element {
  return (
    <section className="mx-auto max-w-md px-4 py-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading battle…</span>
      <div className="animate-pulse">
        {/* Round / status line */}
        <div className="flex items-center justify-between">
          <div className="h-4 w-20 rounded bg-ink-300" />
          <div className="h-4 w-16 rounded bg-ink-200" />
        </div>
        {/* Question card */}
        <div className="mt-5 rounded-2xl bg-surface-card p-6">
          <div className="h-6 w-full rounded bg-ink-200" />
          <div className="mt-3 h-6 w-5/6 rounded bg-ink-200" />
          <div className="mt-8 space-y-3">
            <div className="h-12 w-full rounded-xl bg-ink-300" />
            <div className="h-12 w-full rounded-xl bg-ink-300" />
          </div>
        </div>
        {/* Footer meta */}
        <div className="mt-6 h-4 w-32 rounded bg-ink-200" />
      </div>
    </section>
  );
}
