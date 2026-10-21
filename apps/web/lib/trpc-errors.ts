// Version-skew helper. When the web bundle is deployed ahead of the api
// (Vercel finishes before Railway), a mutation whose procedure doesn't
// exist on the server yet throws TRPCClientError with
// `data.code === 'NOT_FOUND'` / `httpStatus === 404`. When the api is
// mid-outage, the fetch itself fails with no response body at all. In
// both cases the user did nothing wrong and the right UX is a calm
// "We're updating — try again in a few minutes" affordance, not a red
// raw-message error.
//
// This file is deliberately framework-agnostic: it takes `unknown`, not
// `TRPCClientErrorLike`, so pages can pass whatever shape their
// `onError` handler receives without importing tRPC generics.

export function isVersionSkewError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as {
    data?: { code?: string; httpStatus?: number };
    message?: string;
    cause?: unknown;
  };
  // Server reached, but the procedure doesn't exist yet — web is ahead
  // of api.
  if (e.data?.code === 'NOT_FOUND') return true;
  if (e.data?.httpStatus === 404) return true;
  // Transport failure: no response at all. tRPC wraps the underlying
  // fetch failure as `cause`; the plain message varies by browser
  // ("Failed to fetch", "NetworkError", "Load failed").
  if (e.data === undefined) {
    if (e.cause instanceof TypeError) return true;
    if (typeof e.message === 'string' && /fetch|network|load failed/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

// Copy constants. These exact strings are what the <VersionSkewNotice>
// component renders — exporting them here lets other call sites surface
// the same wording without duplication.
export const VERSION_SKEW_COPY = {
  title: "We're updating.",
  body: 'Try again in a few minutes.',
  retry: 'Try again',
} as const;
