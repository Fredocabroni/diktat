import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { fakeDb, type FakeQueryResult, makeCtx } from '../helpers.js';

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
    const userRow = {
      id: 'user-123',
      handle: 'citizen_abcdef0123',
      display_name: null,
      avatar_url: null,
      current_ap: 100,
      tier_id: 0,
      fingerprint: {},
      onboarded_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      timezone: 'America/New_York',
      is_bot: false,
      last_active_at: null,
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
      fingerprint: {},
      onboarded_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      timezone: 'America/New_York',
      is_bot: false,
      last_active_at: null,
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
  it('stamps onboarded_at and returns the row', async () => {
    const { db, calls } = fakeDb('users', {
      data: { id: 'user-123', onboarded_at: '2026-04-20T12:00:00Z' },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.user.completeOnboarding();
    expect(result.onboarded_at).toBe('2026-04-20T12:00:00Z');

    const updateCall = calls.ops.find((op) => op.op === 'update');
    expect(updateCall?.args[0]).toHaveProperty('onboarded_at');
  });
});
