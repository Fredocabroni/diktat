// Tribe picker stub. Real list + join action land in PR #6 alongside
// migration 0008 (seed starter tribes).

import Link from 'next/link';

export default function OnboardTribePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <h1 className="font-display text-2xl font-bold">Choose a tribe</h1>
      <p className="mt-3 text-text-secondary">Five starter tribes ship in the next release.</p>
      <Link
        href="/onboard/preview"
        className="mt-8 rounded-full bg-accent-primary px-4 py-3 text-center font-semibold text-white"
      >
        Continue
      </Link>
    </main>
  );
}
