// Branded 404. Exercised by battles/[id] notFound() (missing/forbidden
// battle) and any unmatched route. Server component — same column + tone as
// the error boundaries, with a brand link home.

import Link from 'next/link';

export default function NotFound(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <p className="font-display text-5xl font-bold text-text-tertiary">404</p>
      <h1 className="mt-4 font-display text-2xl font-bold text-text-primary">
        We couldn&rsquo;t find that.
      </h1>
      <p className="mt-3 text-sm text-text-secondary">
        The page you&rsquo;re after doesn&rsquo;t exist or has moved.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex h-12 items-center justify-center rounded-xl bg-brand px-6 font-medium text-brand-fg"
      >
        Go home
      </Link>
    </main>
  );
}
