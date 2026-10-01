// Origin-presence gate.
//
// Browser-facing routes (`/trpc/*`) must carry an `Origin` header. A
// request with no Origin is either (a) a legitimate same-origin fetch
// that forgot the header — browsers do not elide Origin on cross-origin
// requests, so this is only possible from a dev script or a non-browser
// client — or (b) a non-browser caller that should not be hitting the
// browser-facing surface. Either way we reject it, not out of
// exploitability today (the API is bearer-only, `credentials: false`),
// but to flip the posture from "fail-open on absent Origin" to
// "fail-closed, document the exceptions."
//
// Legitimate no-Origin callers — exempt by exact-path match:
//
//   `/health` — Railway liveness probe. Server-to-server; the Railway
//               orchestrator does not send Origin. Also our boot-log
//               smoke test (`curl /health`) which has no Origin either.
//
// Everything else requires `Origin`. OPTIONS preflight requests ALWAYS
// carry Origin (that is what makes them a preflight); an OPTIONS without
// Origin is not a legitimate preflight and is correctly rejected here.
//
// This gate runs BEFORE the `@fastify/cors` plugin registers its own
// onRequest hook. Rejection short-circuits the request lifecycle with a
// 403 and a plain JSON body — no CORS response headers, since the caller
// never sent an Origin to allow.

export const NO_ORIGIN_ALLOWED_PATHS: ReadonlySet<string> = new Set(['/health']);

export interface OriginGateInput {
  readonly url: string;
  readonly originHeader: string | undefined;
}

export interface OriginGateDecision {
  readonly reject: boolean;
  readonly reason?: 'missing_origin';
}

export function evaluateOriginGate(input: OriginGateInput): OriginGateDecision {
  const pathOnly = input.url.split('?', 1)[0] ?? '';
  if (NO_ORIGIN_ALLOWED_PATHS.has(pathOnly)) {
    return { reject: false };
  }
  const origin = input.originHeader?.trim() ?? '';
  if (origin.length === 0) {
    return { reject: true, reason: 'missing_origin' };
  }
  return { reject: false };
}

// Response body sent on rejection. Kept inline here so the hook caller
// can `.send(ORIGIN_GATE_REJECTED_BODY)` without the body shape leaking
// into `server.ts`. Shape mirrors the outer-hook 429 body: a short
// `error` tag plus a plain-English message. No field discloses which
// paths are exempt — avoids a 403 oracle that could enumerate the
// allowlist.
export const ORIGIN_GATE_REJECTED_BODY = Object.freeze({
  error: 'origin_required',
  message: 'This endpoint requires an Origin header.',
});
