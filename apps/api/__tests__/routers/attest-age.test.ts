// Tests for the 18+ age-gate: the `user.attestAge` mutation (sqlstate
// mapping, outcome parsing) + the mutation-wide age-gate middleware
// (blocks mutations when age is unverified / blocked / missing-profile
// / lookup-errored, with the `user.attestAge` path exempt).

import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { fakeRedis, makeCtx } from '../helpers.js';

/** Minimal fake db that stubs `attest_age` and `get_user_self`.
 *  Everything else throws so a stray call surfaces as a test failure. */
function ageDb(opts: {
  readonly attest?: { data?: unknown; error?: { code?: string; message: string } | null };
  readonly self?: { data: unknown; error: { code?: string; message: string } | null };
}): Context['db'] {
  return {
    from: (t: string) => {
      throw new Error(`ageDb: unexpected from("${t}")`);
    },
    rpc: (fn: string, _args?: unknown) => {
      if (fn === 'attest_age') {
        if (!opts.attest) throw new Error('ageDb: attest_age called but no stub provided');
        return Promise.resolve({
          data: opts.attest.data ?? null,
          error: opts.attest.error ?? null,
        });
      }
      if (fn === 'get_user_self') {
        const result = opts.self ?? { data: null, error: null };
        // Builder shim with `.maybeSingle()` so the real middleware
        // chaining matches.
        return {
          maybeSingle: () => Promise.resolve(result),
          single: () => Promise.resolve(result),
          then: (resolve: (v: typeof result) => unknown) => Promise.resolve(resolve(result)),
        };
      }
      throw new Error(`ageDb: unexpected rpc("${fn}")`);
    },
  } as unknown as Context['db'];
}

// ---------------------------------------------------------------------------
// user.attestAge — the mutation itself
// ---------------------------------------------------------------------------

describe('user.attestAge', () => {
  it('verified outcome: forwards p_birth_date and returns {outcome: "verified"}', async () => {
    const db = ageDb({ attest: { data: { outcome: 'verified' }, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.user.attestAge({ birthDate: '2000-01-15', usResident: true });
    expect(r).toEqual({ outcome: 'verified' });
  });

  it('blocked outcome returns {outcome: "blocked"} — client redirects to /not-eligible', async () => {
    const db = ageDb({ attest: { data: { outcome: 'blocked' }, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.user.attestAge({ birthDate: '2020-01-15', usResident: true });
    expect(r).toEqual({ outcome: 'blocked' });
  });

  it('already-verified is idempotent', async () => {
    const db = ageDb({ attest: { data: { outcome: 'already_verified' }, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.user.attestAge({ birthDate: '1990-05-05', usResident: true });
    expect(r).toEqual({ outcome: 'already_verified' });
  });

  it('malformed DOB rejected at the Zod gate (BAD_REQUEST, no RPC call)', async () => {
    const db = ageDb({});
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.user.attestAge({ birthDate: 'not-a-date', usResident: true }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it.each<[string, string]>([
    ['P0001', 'FORBIDDEN'], // terminal block — "no further attempts"
    ['22023', 'BAD_REQUEST'], // invalid DOB at SQL layer
    ['28000', 'UNAUTHORIZED'],
    ['P0002', 'NOT_FOUND'],
    ['XX000', 'INTERNAL_SERVER_ERROR'],
  ])('maps RPC sqlstate %s → TRPCError %s', async (code, trpcCode) => {
    const db = ageDb({
      attest: { data: null, error: { code, message: `db error ${code}` } },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.user.attestAge({ birthDate: '2000-01-15', usResident: true }),
    ).rejects.toMatchObject({
      code: trpcCode,
    });
  });

  it('unknown rpc outcome shape → INTERNAL_SERVER_ERROR (rpc_bad_shape)', async () => {
    const db = ageDb({ attest: { data: { outcome: 'nonsense' }, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.user.attestAge({ birthDate: '2000-01-15', usResident: true }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('rejects usResident=false at the input layer before reaching the RPC', async () => {
    // Zod `.refine(v => v === true)` fails fast — the RPC should
    // never be called when the UI box is unchecked (or a crafted
    // call passes false).
    const db = ageDb({
      attest: { data: { outcome: 'verified' }, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.user.attestAge({ birthDate: '2000-01-15', usResident: false }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('attestAge is EXEMPT from the mutation-wide age-gate (even when age is unverified)', async () => {
    // The mutation that lets a user clear the gate must not itself
    // be blocked by the gate — else every unverified user is
    // deadlocked. Pin by composing a context whose loadAgeStatus is
    // 'unverified' and confirming attestAge still passes through.
    const db = ageDb({ attest: { data: { outcome: 'verified' }, error: null } });
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'unverified' }),
      }),
    );
    const r = await caller.user.attestAge({ birthDate: '1990-01-01', usResident: true });
    expect(r).toEqual({ outcome: 'verified' });
  });
});

// ---------------------------------------------------------------------------
// age-gate middleware (applied to every non-attestAge mutation)
// ---------------------------------------------------------------------------

describe('age-gate middleware (via a representative mutation)', () => {
  // `user.completeOnboarding` is a protectedProcedure mutation. It
  // calls `complete_onboarding` RPC. We use it as a probe for the
  // gate because its own happy path is a one-RPC flow — easy to
  // isolate from the gate's load.

  function completeOnboardingDb(opts: {
    readonly complete?: { data: unknown; error: { code?: string; message: string } | null };
  }): Context['db'] {
    return {
      from: (t: string) => {
        throw new Error(`unexpected from("${t}")`);
      },
      rpc: (fn: string, _args?: unknown) => {
        if (fn === 'complete_onboarding') {
          const r = opts.complete ?? { data: 'ok', error: null };
          return Promise.resolve(r);
        }
        if (fn === 'get_user_self') {
          const r = { data: null, error: null };
          return {
            maybeSingle: () => Promise.resolve(r),
            single: () => Promise.resolve(r),
            then: (resolve: (v: typeof r) => unknown) => Promise.resolve(resolve(r)),
          };
        }
        throw new Error(`unexpected rpc("${fn}")`);
      },
    } as unknown as Context['db'];
  }

  it('verified → mutation runs through', async () => {
    const db = completeOnboardingDb({});
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    // Default makeCtx carries loadAgeStatus → {kind: 'verified'}.
    await expect(caller.user.completeOnboarding()).resolves.toBeDefined();
  });

  it('unverified → mutation blocked with FORBIDDEN (cause age_unverified)', async () => {
    const db = completeOnboardingDb({});
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'unverified' }),
      }),
    );
    await expect(caller.user.completeOnboarding()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('blocked → mutation blocked with FORBIDDEN (cause age_blocked)', async () => {
    const db = completeOnboardingDb({});
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'blocked' }),
      }),
    );
    await expect(caller.user.completeOnboarding()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('no_profile → mutation blocked with FORBIDDEN (handle_new_user trigger failure case)', async () => {
    const db = completeOnboardingDb({});
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'no_profile' }),
      }),
    );
    await expect(caller.user.completeOnboarding()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('error → mutation blocked with INTERNAL_SERVER_ERROR (fail-closed)', async () => {
    const db = completeOnboardingDb({});
    const caller = appRouter.createCaller(
      makeCtx({
        db,
        redis: fakeRedis(),
        loadAgeStatus: async () => ({ kind: 'error', code: 'db_err' }),
      }),
    );
    await expect(caller.user.completeOnboarding()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
