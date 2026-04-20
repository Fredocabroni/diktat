import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';

describe('userRouter.me', () => {
  it('returns the joined profile', async () => {
    const profile = {
      id: 'user-123',
      handle: 'citizen_abcdef0123',
      display_name: null,
      avatar_url: null,
      current_ap: 100,
      tier_id: 0,
      onboarded_at: null,
      tiers: { id: 0, name: 'Citizen', payout_eligible: false, floor_protected: true },
      streaks: {
        current_length: 0,
        longest_length: 0,
        last_action_date: null,
        freeze_tokens: 0,
      },
    };
    const { db } = fakeDb('users', { data: profile, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.user.me()).toEqual(profile);
  });

  it('UNAUTHORIZED for unauthed callers', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));

    await expect(caller.user.me()).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('NOT_FOUND when row missing', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.user.me()).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
