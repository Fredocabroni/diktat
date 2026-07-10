'use client';

// Root error boundary — catches errors thrown above or in the (app) shell
// (e.g. the layout's own auth/RPC render path) and anywhere outside it.
// Same recoverable shape as the (app) boundary; this one is the last line
// before Next's default error screen.

import { useEffect } from 'react';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error('app.root.error', { digest: error.digest });
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
        We hit an unexpected error. Try again — if it keeps happening, refresh the app.
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
