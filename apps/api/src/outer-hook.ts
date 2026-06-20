// Outer-hook 429 response body. Extracted from `server.ts` so the
// body shape is unit-testable without booting the Fastify app
// (server.ts top-level-awaits its registers + .listen()).
//
// `limit` was deliberately dropped: disclosing the numeric ceiling
// (1200/min) on the 429 body lets an adversary calibrate requests to
// stay just under it forever. The RFC 6585 §4 way to communicate
// timing is the `Retry-After` header (set on the same response in
// server.ts), which is sufficient for legitimate clients without
// giving abusers a calibration signal. PR #65 round-3 reviewer
// MEDIUM-3.

export interface OuterHookBlockedBody {
  readonly error: string;
  readonly window: string;
}

export function buildOuterHookBlockedBody(): OuterHookBlockedBody {
  return { error: 'Too many requests.', window: '60s' };
}
