import { describe, expect, it } from 'vitest';

import { buildOuterHookBlockedBody } from '../src/outer-hook.js';

// ---------------------------------------------------------------------------
// PR #65 round-3 MEDIUM-3 — outer-hook 429 body no longer leaks limit.
//
// The Fastify outer hook's 429 body previously included
// `limit: OUTER_HOOK_PER_MIN` (1200), letting an adversary read the
// numeric ceiling from a single 429 response and calibrate requests to
// 1199/min — under the cap, forever. RFC 6585 §4 covers the
// communication need via the `Retry-After` header (set on the same
// response in server.ts:104); the body field added no value for a
// legitimate client.
//
// The body shape lives in `outer-hook.ts` so server.ts can stay
// unit-testable without booting the Fastify app (server.ts
// top-level-awaits its registers + .listen()).
// ---------------------------------------------------------------------------
describe('buildOuterHookBlockedBody — MEDIUM-3 regression guard', () => {
  it('returns exactly { error, window } with no limit field', () => {
    const body = buildOuterHookBlockedBody();
    expect(body).toEqual({ error: 'Too many requests.', window: '60s' });
    expect(Object.keys(body).sort()).toEqual(['error', 'window']);
  });

  it('does NOT include the numeric rate-limit ceiling (calibration oracle)', () => {
    const body = buildOuterHookBlockedBody();
    // Defense-in-depth: catch any future revival of the field, however
    // named. The ceiling value (1200) must never appear in the body.
    expect(body).not.toHaveProperty('limit');
    expect(body).not.toHaveProperty('perMin');
    expect(body).not.toHaveProperty('max');
    expect(body).not.toHaveProperty('ceiling');

    // Stringify-scan: a future refactor that nests the ceiling inside a
    // sub-object also gets caught.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/1200|1_200/);
  });
});
