import { describe, expect, it } from 'vitest';

import { buildOuterHookBlockedBody, OUTER_HOOK_WINDOW_SEC } from '../src/outer-hook.js';

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
    expect(body).toEqual({ error: 'Too many requests.', window: `${OUTER_HOOK_WINDOW_SEC}s` });
    expect(Object.keys(body).sort()).toEqual(['error', 'window']);
  });

  it('retains the public response contract — error + window both present and non-empty', () => {
    // The 429 body is a public response contract; clients can depend
    // on `error` (rendered as a user-facing string) and `window` (used
    // to set retry timing UX). The `toEqual` above already pins the
    // shape, but per-field assertions name each field explicitly so a
    // future refactor that drops `error` or `window` fails with a
    // clearer message ("expected body.window to be '60s'") than a
    // structural toEqual diff. Two failure modes are guarded
    // independently:
    //   - drop a field entirely (e.g. ship `{ error }`)
    //   - shorten a field to empty string (e.g. ship `{ error: '' }`)
    const body = buildOuterHookBlockedBody();

    expect(body.error).toBe('Too many requests.');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);

    expect(body.window).toBe(`${OUTER_HOOK_WINDOW_SEC}s`);
    expect(typeof body.window).toBe('string');
    expect(body.window.length).toBeGreaterThan(0);
  });

  it('derives window from OUTER_HOOK_WINDOW_SEC — no magic literal', () => {
    // LOW-4 regression guard: the body's `window` field MUST be derived
    // from the same `OUTER_HOOK_WINDOW_SEC` constant that server.ts's
    // responseMeta uses as the Retry-After fallback. A future change to
    // the constant must propagate to the body string; a future refactor
    // that re-introduces a hardcoded `'60s'` (or any other literal) and
    // happens to match the constant today would still drift the moment
    // someone tunes the window. This test fires loud either way:
    //
    //   - constant changed but body not updated → body.window !==
    //     `${OUTER_HOOK_WINDOW_SEC}s`, fails.
    //   - body string hardcoded back to a literal that happens to
    //     match → still passes today, but the next constant tune
    //     surfaces the drift via the same assertion.
    const body = buildOuterHookBlockedBody();
    expect(body.window).toBe(`${OUTER_HOOK_WINDOW_SEC}s`);

    // Belt-and-suspenders: confirm the constant is what we think it is
    // at test time. A future bump to e.g. 30s should require a
    // deliberate update here as a checkpoint that the change went
    // through review (not a silent drift).
    expect(OUTER_HOOK_WINDOW_SEC).toBe(60);
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
