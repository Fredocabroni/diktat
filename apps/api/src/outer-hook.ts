// Outer-hook 429 response body + the window constant the body advertises.
//
// Body shape extracted from `server.ts` so it's unit-testable without
// booting the Fastify app (server.ts top-level-awaits its registers +
// .listen()).
//
// `limit` was deliberately dropped: disclosing the numeric ceiling
// (1200/min) on the 429 body lets an adversary calibrate requests to
// stay just under it forever. The RFC 6585 §4 way to communicate
// timing is the `Retry-After` header (set on the same response in
// server.ts), which is sufficient for legitimate clients without
// giving abusers a calibration signal. PR #65 round-3 reviewer
// MEDIUM-3.
//
// `OUTER_HOOK_WINDOW_SEC` lives here (not in server.ts) so the body
// builder can derive its `window` string from the same single source
// of truth that server.ts's `responseMeta` Retry-After fallback uses.
// Eliminates the decoupled `'60s'` literal flagged by PR #67 round-1
// reviewer LOW-4 — change the constant in one place and both the body
// string and the fallback header update together. server.ts imports
// the constant from this file (one-way import; no cycle).

export const OUTER_HOOK_WINDOW_SEC = 60;

export interface OuterHookBlockedBody {
  readonly error: string;
  readonly window: string;
}

export function buildOuterHookBlockedBody(): OuterHookBlockedBody {
  return { error: 'Too many requests.', window: `${OUTER_HOOK_WINDOW_SEC}s` };
}
