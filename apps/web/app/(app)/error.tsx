'use client';

// Recoverable error boundary for the (app) shell. Error boundaries must be
// client components. Tone matches the layout's inline-error block
// ((app)/layout.tsx) — display heading + secondary body — plus a brand
// "Try again" CTA that calls reset() to re-render the segment.

import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    // Surface to the browser console; server-side digests already log.
    console.error('app.segment.error', { digest: error.digest });
  }, [error]);

  return (
    <main role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-2xl text-danger-soft-fg"
      >
        !
      </span>
      <h1 className="mt-5 font-display text-2xl font-bold text-text-primary">
        Something went wrong.
      </h1>
      <p className="mt-3 text-sm text-text-secondary">
        We hit an error loading this screen. Try again — if it keeps happening, refresh the app.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex h-12 items-center justify-center rounded-xl bg-brand px-6 font-medium text-brand-fg"
      >
        Try again
      </button>
    </main>
  );
}
