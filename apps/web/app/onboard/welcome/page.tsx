// Onboarding welcome. Full flow lands in PR #6; this stub lives here so
// the (app) layout's onboarding redirect has a destination in PR #3.

import Link from 'next/link';

export default function OnboardWelcomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <h1 className="font-display text-3xl font-bold">Welcome to the arena.</h1>
      <p className="mt-3 text-text-secondary">
        Pick a tribe, see tonight&rsquo;s drop, and you&rsquo;re in.
      </p>
      <Link
        href="/onboard/tribe"
        className="mt-8 rounded-full bg-accent-primary px-4 py-3 text-center font-semibold text-white"
      >
        Pick a tribe
      </Link>
    </main>
  );
}
