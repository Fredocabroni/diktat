// First screen of onboarding. Sets the voice and orients the user —
// nothing is locked behind this screen. The "Pick a tribe" and "Skip
// for now" paths both lead into the arena; the tribe step is optional
// per ADDICTION_ARCHITECTURE §11 (no forced choice to proceed).

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { trpc } from '../../../lib/trpc';

export default function OnboardWelcomePage() {
  const router = useRouter();
  const complete = trpc.user.completeOnboarding.useMutation({
    onSuccess: () => router.push('/'),
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-between px-6 py-10">
      <div>
        <h1 className="font-display text-4xl font-bold tracking-tight text-text-primary">
          Welcome to the arena.
        </h1>
        <p className="mt-3 text-text-secondary">
          Politics is a combat sport. Here, it has rules, receipts, and points.
        </p>
        <ul className="mt-8 space-y-3 text-sm text-text-secondary">
          <li>
            <span className="font-semibold text-text-primary">Battle</span> on the day&rsquo;s news
            — trivia, debate, prediction.
          </li>
          <li>
            <span className="font-semibold text-text-primary">Earn AP</span>. One score. Twelve
            tiers.
          </li>
          <li>
            <span className="font-semibold text-text-primary">Stay honest</span>. Sources get cited.
            Facts get checked.
          </li>
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <Link
          href="/onboard/tribe"
          className="rounded-full bg-brand px-4 py-3 text-center font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99]"
        >
          Pick a tribe
        </Link>
        <button
          type="button"
          onClick={() => complete.mutate()}
          disabled={complete.isPending}
          className="rounded-full px-4 py-3 text-center text-sm font-semibold text-text-secondary transition hover:text-text-primary disabled:opacity-60"
        >
          {complete.isPending ? 'One moment…' : 'Skip for now'}
        </button>
      </div>
    </main>
  );
}
