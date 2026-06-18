import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { fakeDb, type FakeQueryResult, makeCtx } from '../helpers.js';

// Generalised RPC + table fake that supports an arbitrary map of rpc
// names and table names. Used by the mutation tests below (each route
// pivots to a SECURITY DEFINER RPC per migration 20260618170000).
function fakeRpcDb(opts: {
  rpcs?: Record<string, FakeQueryResult<unknown>>;
  tables?: Record<string, FakeQueryResult<unknown>>;
  rpcCalls?: { fn: string; args: unknown }[];
}): Context['db'] {
  const rpcResponses = opts.rpcs ?? {};
  const tableResponses = opts.tables ?? {};
  const calls = opts.rpcCalls;
  const makeBuilder = (result: FakeQueryResult<unknown>) => {
    const builder: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'lt', 'lte', 'gt', 'gte', 'order', 'limit']) {
      builder[op] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve(result);
    builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (v: FakeQueryResult<unknown>) => unknown) =>
      Promise.resolve(resolve(result));
    return builder;
  };
  return {
    from: (table: string) => {
      const r = tableResponses[table];
      if (!r) throw new Error(`fakeRpcDb: no table stubbed for "${table}"`);
      return makeBuilder(r);
    },
    rpc: (fn: string, args?: unknown) => {
      calls?.push({ fn, args });
      const r = rpcResponses[fn];
      if (!r) throw new Error(`fakeRpcDb: no rpc stubbed for "${fn}"`);
      return makeBuilder(r);
    },
  } as unknown as Context['db'];
}

// user.me now fans out to three calls: rpc('get_user_self') for the
// caller's full users row (private columns), then PostgREST reads on
// `tiers` and `streaks` for the joined denormalizations. Helper below
// stubs all three sources.
function fakeUserMeDb(opts: {
  rpc?: FakeQueryResult<Record<string, unknown>>;
  tier?: FakeQueryResult<Record<string, unknown>>;
  streak?: FakeQueryResult<Record<string, unknown>>;
}): Context['db'] {
  const rpcResponses: Record<string, FakeQueryResult<unknown>> = {
    get_user_self: opts.rpc ?? { data: null, error: null },
  };
  const tableResponses: Record<string, FakeQueryResult<unknown>> = {
    tiers: opts.tier ?? { data: null, error: null },
    streaks: opts.streak ?? { data: null, error: null },
  };

  const makeBuilder = (result: FakeQueryResult<unknown>) => {
    const builder: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'lt', 'lte', 'gt', 'gte', 'order', 'limit']) {
      builder[op] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve(result);
    builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (v: FakeQueryResult<unknown>) => unknown) =>
      Promise.resolve(resolve(result));
    return builder;
  };

  return {
    from: (table: string) => {
      const r = tableResponses[table];
      if (!r) throw new Error(`fakeUserMeDb: no response stubbed for "${table}"`);
      return makeBuilder(r);
    },
    rpc: (fn: string) => {
      const r = rpcResponses[fn];
      if (!r) throw new Error(`fakeUserMeDb: no rpc stubbed for "${fn}"`);
      return makeBuilder(r);
    },
  } as unknown as Context['db'];
}

describe('userRouter.me', () => {
  it('returns the joined profile from rpc + tiers + streaks', async () => {
    // The RPC returns only the explicit nine-column set per the round-2
    // hardening — `fingerprint`, `timezone`, `last_active_at`,
    // `created_at`, `updated_at` are structurally absent. The fake
    // mirrors that exactly so a future refactor that re-introduces a
    // private column on the SDK payload fails this test.
    const userRow = {
      id: 'user-123',
      handle: 'citizen_abcdef0123',
      display_name: null,
      avatar_url: null,
      current_ap: 100,
      tier_id: 0,
      is_bot: false,
      onboarded_at: null,
      notification_preferences: {},
    };
    const tier = { id: 0, name: 'Citizen', payout_eligible: false, floor_protected: true };
    const streak = {
      current_length: 0,
      longest_length: 0,
      last_action_date: null,
      freeze_tokens: 0,
    };
    const db = fakeUserMeDb({
      rpc: { data: userRow, error: null },
      tier: { data: tier, error: null },
      streak: { data: streak, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.user.me()).toEqual({
      id: userRow.id,
      handle: userRow.handle,
      display_name: userRow.display_name,
      avatar_url: userRow.avatar_url,
      current_ap: userRow.current_ap,
      tier_id: userRow.tier_id,
      onboarded_at: userRow.onboarded_at,
      notification_preferences: userRow.notification_preferences,
      tiers: tier,
      streaks: streak,
    });
  });

  it('UNAUTHORIZED for unauthed callers', async () => {
    const db = fakeUserMeDb({ rpc: { data: null, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));

    await expect(caller.user.me()).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('NOT_FOUND when the rpc returns null', async () => {
    const db = fakeUserMeDb({ rpc: { data: null, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.me()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('INTERNAL_SERVER_ERROR when the rpc errors', async () => {
    const db = fakeUserMeDb({
      rpc: { data: null, error: { code: '42501', message: 'permission denied' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.me()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('INTERNAL_SERVER_ERROR when the tier fetch errors', async () => {
    const userRow = {
      id: 'user-123',
      tier_id: 0,
      handle: 'h',
      display_name: null,
      avatar_url: null,
      current_ap: 100,
      is_bot: false,
      onboarded_at: null,
      notification_preferences: {},
    };
    const db = fakeUserMeDb({
      rpc: { data: userRow, error: null },
      tier: { data: null, error: { message: 'boom' } },
      streak: { data: null, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.me()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('userRouter.updateHandle', () => {
  it('rejects handles that are too short', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.updateHandle({ handle: 'ab' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects handles with disallowed characters', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.updateHandle({ handle: 'has space' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('lowercases and persists a valid handle', async () => {
    const { db, calls } = fakeDb('users', {
      data: { id: 'user-123', handle: 'voter_2026' },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.user.updateHandle({ handle: 'Voter_2026' });
    expect(result.handle).toBe('voter_2026');

    const updateCall = calls.ops.find((op) => op.op === 'update');
    expect(updateCall?.args[0]).toMatchObject({ handle: 'voter_2026' });
  });

  it('CONFLICT on unique-violation', async () => {
    const { db } = fakeDb('users', {
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.updateHandle({ handle: 'taken' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('userRouter.completeOnboarding', () => {
  it('returns the rpc-stamped onboarded_at', async () => {
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = fakeRpcDb({
      rpcs: {
        complete_onboarding: { data: '2026-04-20T12:00:00Z', error: null },
      },
      rpcCalls,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.user.completeOnboarding();
    expect(result).toEqual({
      id: 'user-123',
      onboarded_at: '2026-04-20T12:00:00Z',
    });
    expect(rpcCalls).toEqual([{ fn: 'complete_onboarding', args: undefined }]);
  });

  it('NOT_FOUND when the rpc returns null', async () => {
    const db = fakeRpcDb({
      rpcs: { complete_onboarding: { data: null, error: null } },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.completeOnboarding()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('INTERNAL_SERVER_ERROR when the rpc errors', async () => {
    const db = fakeRpcDb({
      rpcs: {
        complete_onboarding: { data: null, error: { code: '28000', message: 'unauth' } },
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.completeOnboarding()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('userRouter.updateNotificationPreferences', () => {
  it('forwards the partial patch as p_prefs and returns the merged jsonb', async () => {
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const merged = { streak_risk_push: false };
    const db = fakeRpcDb({
      rpcs: {
        update_notification_preferences: { data: merged, error: null },
      },
      rpcCalls,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.user.updateNotificationPreferences({ streakRiskPush: false });
    expect(result).toEqual({
      id: 'user-123',
      notification_preferences: merged,
    });
    expect(rpcCalls).toEqual([
      { fn: 'update_notification_preferences', args: { p_prefs: { streak_risk_push: false } } },
    ]);
  });

  it('sends an empty patch when no input keys are provided (no-op merge)', async () => {
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = fakeRpcDb({
      rpcs: {
        update_notification_preferences: { data: {}, error: null },
      },
      rpcCalls,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await caller.user.updateNotificationPreferences({});
    expect(rpcCalls[0]?.args).toEqual({ p_prefs: {} });
  });

  it('INTERNAL_SERVER_ERROR when the rpc errors', async () => {
    const db = fakeRpcDb({
      rpcs: {
        update_notification_preferences: {
          data: null,
          error: { code: '22023', message: 'unknown keys' },
        },
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.user.updateNotificationPreferences({ streakRiskPush: true }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('userRouter.setTimezone', () => {
  it('forwards p_tz and returns the stamped value', async () => {
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = fakeRpcDb({
      rpcs: { set_user_timezone: { data: 'America/New_York', error: null } },
      rpcCalls,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.user.setTimezone({ timezone: 'America/New_York' });
    expect(result).toEqual({ id: 'user-123', timezone: 'America/New_York' });
    expect(rpcCalls).toEqual([{ fn: 'set_user_timezone', args: { p_tz: 'America/New_York' } }]);
  });

  it('rejects unknown timezones at the Zod gate before reaching the rpc', async () => {
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = fakeRpcDb({
      rpcs: { set_user_timezone: { data: null, error: null } },
      rpcCalls,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.user.setTimezone({ timezone: 'Atlantis/Lost_City' }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(rpcCalls).toEqual([]); // never reached the rpc
  });

  it('INTERNAL_SERVER_ERROR when the rpc errors', async () => {
    const db = fakeRpcDb({
      rpcs: {
        set_user_timezone: { data: null, error: { code: '22023', message: 'unknown tz' } },
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.setTimezone({ timezone: 'America/New_York' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
