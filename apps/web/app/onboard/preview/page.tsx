// Preview of the Drop ritual. Real news_topics data lands in Phase 3;
// this screen shows the shape so the user knows what to expect before
// they get dropped into the arena. "Enter the arena" calls
// user.completeOnboarding, which stamps users.onboarded_at so the
// (app) layout stops redirecting back here.

'use client';

import { useRouter } from 'next/navigation';

import { trpc } from '../../../lib/trpc';

export default function OnboardPreviewPage() {
  const router = useRouter();
  const complete = trpc.user.completeOnboarding.useMutation({
    onSuccess: () => router.push('/'),
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-between px-6 py-10">
      <div>
        <h1 className="font-display text-2xl font-bold">Tonight&rsquo;s Drop</h1>
        <p className="mt-3 text-sm text-text-secondary">
          Every evening, one news topic becomes the arena. Battle it from three angles — trivia,
          debate, prediction — and the points compound.
        </p>

        <section className="mt-6 rounded-2xl bg-surface-elevated p-5 ring-1 ring-white/5">
          <p className="text-xs uppercase tracking-wide text-text-tertiary">Tonight — Preview</p>
          <p className="mt-2 font-display text-lg font-bold text-text-primary">
            Real topics drop in Phase 3.
          </p>
          <p className="mt-2 text-sm text-text-secondary">
            You&rsquo;ll see the evening topic, the sources, and the three battle modes. For now,
            your wallet, profile, and tribe are live.
          </p>
        </section>

        <ul className="mt-6 space-y-2 text-sm text-text-secondary">
          <li>
            <span className="font-semibold text-text-primary">Trivia</span> — fastest correct
            answer.
          </li>
          <li>
            <span className="font-semibold text-text-primary">Debate</span> — argue your side,
            sources required.
          </li>
          <li>
            <span className="font-semibold text-text-primary">Prediction</span> — stake AP on the
            outcome.
          </li>
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => complete.mutate()}
          disabled={complete.isPending}
          className="rounded-full bg-accent-primary px-4 py-3 text-center font-semibold text-white disabled:opacity-60"
        >
          {complete.isPending ? 'One moment…' : 'Enter the arena'}
        </button>
        {complete.error && (
          <p className="text-center text-sm text-accent-danger">
            Something got stuck. Try that again.
          </p>
        )}
      </div>
    </main>
  );
}
