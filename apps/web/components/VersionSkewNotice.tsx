// Calm fallback for mutation / query errors caused by a web-vs-api
// version skew or a transient api outage. Replaces a raw red error
// panel when `isVersionSkewError(err)` is true — see
// `apps/web/lib/trpc-errors.ts` for the predicate. Reusable from any
// page that calls a tRPC procedure the server might not know yet.

'use client';

import { VERSION_SKEW_COPY } from '../lib/trpc-errors';

export interface VersionSkewNoticeProps {
  readonly onRetry: () => void;
  /** Set to true while the retry mutation / query is in flight so the
   *  button self-disables and prevents double-fire. */
  readonly busy?: boolean;
}

export function VersionSkewNotice(props: VersionSkewNoticeProps): React.JSX.Element {
  const { onRetry, busy = false } = props;
  return (
    <div
      role="status"
      aria-live="polite"
      data-component="VersionSkewNotice"
      className="flex flex-col gap-3 rounded-xl border border-ink-300 bg-surface-card px-4 py-4 text-text-primary"
    >
      <p className="text-sm font-medium">{VERSION_SKEW_COPY.title}</p>
      <p className="text-sm text-text-secondary">{VERSION_SKEW_COPY.body}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        data-component="VersionSkewNotice.Retry"
        className="self-start rounded-full border border-ink-400 px-4 py-2 text-sm font-semibold text-text-primary transition hover:border-ink-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Trying…' : VERSION_SKEW_COPY.retry}
      </button>
    </div>
  );
}
