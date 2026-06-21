import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { extractRetryAfterSec, RateLimitCause } from '../src/rate-limit.js';

// ---------------------------------------------------------------------------
// PR #62 round-3 leftover #8 — typed RateLimitCause.
//
// Replaces the `as unknown as Error` casts at every rate-limit throw
// site + the `cause as { retryAfterSec?: number }` cast in server.ts's
// responseMeta. `extractRetryAfterSec` is the consumer-side helper
// that does an `instanceof RateLimitCause` check — if a future
// refactor swaps the cause shape on either side without updating the
// other, the instanceof returns false and the fallback fires (loudly,
// not silently — the consumer logs the fallback path in production).
//
// This file pins the contract: positive happy path, three rejection
// paths (absent / wrong-type / non-positive), and TRPCError integration
// (the cause field actually accepts the typed instance without a cast).
// ---------------------------------------------------------------------------

describe('RateLimitCause — Error subclass shape', () => {
  it('extends Error, has the expected name, and exposes retryAfterSec', () => {
    const cause = new RateLimitCause(42);
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toBeInstanceOf(RateLimitCause);
    expect(cause.name).toBe('RateLimitCause');
    expect(cause.retryAfterSec).toBe(42);
    expect(cause.message).toMatch(/retry-after 42s/);
  });

  it('is assignable to TRPCError.cause without any cast', () => {
    // This is the load-bearing assertion: tRPC types TRPCError.cause as
    // `Error | undefined`. Before this PR every throw site used
    // `cause: { retryAfterSec } as unknown as Error` to satisfy that
    // type. RateLimitCause being a real Error subclass eliminates the
    // cast entirely — if the next line ever requires `as`, it means
    // the inheritance chain regressed.
    const err = new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Rate limit exceeded.',
      cause: new RateLimitCause(42),
    });
    expect(err.cause).toBeInstanceOf(RateLimitCause);
    expect((err.cause as RateLimitCause).retryAfterSec).toBe(42);
  });
});

describe('extractRetryAfterSec — consumer-side instanceof + fallback', () => {
  it('returns the cause retryAfterSec on the happy path', () => {
    expect(extractRetryAfterSec(new RateLimitCause(42), 60)).toBe(42);
    expect(extractRetryAfterSec(new RateLimitCause(86400), 60)).toBe(86400);
    expect(extractRetryAfterSec(new RateLimitCause(1), 60)).toBe(1);
  });

  // The three "no signal" cases — each MUST hit the explicit fallback
  // path, not silently return 60 because the cast happened to fail in
  // a way the previous shape didn't notice. The fallback is the
  // explicit contract; these tests prove no upstream change can mask
  // a silent drift.

  it('falls back when cause is undefined (no throw-site cause threaded)', () => {
    expect(extractRetryAfterSec(undefined, 60)).toBe(60);
    expect(extractRetryAfterSec(undefined, 86400)).toBe(86400);
  });

  it('falls back when cause is null', () => {
    expect(extractRetryAfterSec(null, 60)).toBe(60);
  });

  it('falls back when cause is the wrong Error subclass (or a plain Error)', () => {
    // A plain `Error` instance with the same field name should NOT be
    // accepted — the instanceof check is what makes this typed.
    const decoy = new Error('rate-limit retry-after 42s') as Error & {
      retryAfterSec?: number;
    };
    decoy.retryAfterSec = 42;
    expect(extractRetryAfterSec(decoy, 60)).toBe(60);

    // Custom error subclass that isn't RateLimitCause.
    class OtherCause extends Error {
      readonly retryAfterSec = 42;
    }
    expect(extractRetryAfterSec(new OtherCause(), 60)).toBe(60);
  });

  it('falls back when cause is a plain object with the same shape', () => {
    // This is the EXACT shape the pre-typed code wrote into `cause`.
    // It still has a numeric retryAfterSec but is not a RateLimitCause
    // instance — the instanceof check correctly rejects.
    const planObject = { retryAfterSec: 42 };
    expect(extractRetryAfterSec(planObject, 60)).toBe(60);
  });

  it('falls back when retryAfterSec is zero', () => {
    expect(extractRetryAfterSec(new RateLimitCause(0), 60)).toBe(60);
  });

  it('falls back when retryAfterSec is negative', () => {
    expect(extractRetryAfterSec(new RateLimitCause(-1), 60)).toBe(60);
    expect(extractRetryAfterSec(new RateLimitCause(-86400), 60)).toBe(60);
  });

  it('honors the caller-supplied fallback value (not a hardcoded 60)', () => {
    // server.ts passes OUTER_HOOK_WINDOW_SEC; AI tier fallback is the
    // BURST_WINDOW_SEC value at the throw site. The helper itself must
    // not bake in a constant.
    expect(extractRetryAfterSec(undefined, 1)).toBe(1);
    expect(extractRetryAfterSec(undefined, 3600)).toBe(3600);
    expect(extractRetryAfterSec(undefined, 86400)).toBe(86400);
  });
});
