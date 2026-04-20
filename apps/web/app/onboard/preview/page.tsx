// Preview of tonight's drop. Stub; PR #6 wires the real
// user.completeOnboarding mutation that sets users.onboarded_at.

import Link from 'next/link';

export default function OnboardPreviewPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <h1 className="font-display text-2xl font-bold">Tonight&rsquo;s drop</h1>
      <p className="mt-3 text-text-secondary">
        Every evening, one news topic becomes the arena. You&rsquo;ll battle, predict, and earn AP.
      </p>
      <Link
        href="/"
        className="mt-8 rounded-full bg-accent-primary px-4 py-3 text-center font-semibold text-white"
      >
        Enter the arena
      </Link>
    </main>
  );
}
