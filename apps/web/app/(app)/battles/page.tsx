import Link from 'next/link';

export default function BattlesPage() {
  return (
    <section className="mx-auto max-w-md px-4 py-6">
      <h1 className="font-display text-2xl font-bold text-text-primary">Battles</h1>
      <p className="mt-2 text-text-secondary">
        Open Debate is live. Trivia and predictions come next.
      </p>

      <Link
        href="/play/open-debate"
        className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-brand px-6 py-3 font-semibold text-brand-fg"
      >
        Start an Open Debate
      </Link>
    </section>
  );
}
