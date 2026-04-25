import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, fakeRedis, makeCtx } from '../helpers.js';

const USER_ID = 'user-123';

describe('matchmakingRouter.enqueue', () => {
  it('writes the user to the sorted set and the meta key', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 850, is_bot: false },
      error: null,
    });
    const redis = fakeRedis();
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    const result = await caller.matchmaking.enqueue({ mode: 'trivia' });

    expect(result.status).toBe('waiting');
    expect(result.ap).toBe(850);
    expect(redis.zset.get('mm:trivia:queue')?.get(USER_ID)).toBe(850);
    const metaRaw = redis.kv.get(`mm:trivia:meta:${USER_ID}`);
    expect(metaRaw).toBeDefined();
    const meta = JSON.parse(metaRaw!);
    expect(meta.ap).toBe(850);
    expect(meta.mode).toBe('trivia');
    expect(typeof meta.joinedAtMs).toBe('number');
  });

  it('rejects with FORBIDDEN when caller is_bot=true', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 600, is_bot: true },
      error: null,
    });
    const redis = fakeRedis();
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    await expect(caller.matchmaking.enqueue({ mode: 'trivia' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(redis.zset.get('mm:trivia:queue')?.size ?? 0).toBe(0);
  });

  it('rejects with NOT_FOUND when the user row is missing', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const redis = fakeRedis();
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    await expect(caller.matchmaking.enqueue({ mode: 'trivia' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('matchmakingRouter.cancel', () => {
  it('removes the user from the queue and reports wasQueued=true', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 600, is_bot: false },
      error: null,
    });
    const redis = fakeRedis();
    redis.zset.set('mm:trivia:queue', new Map([[USER_ID, 600]]));
    redis.kv.set(`mm:trivia:meta:${USER_ID}`, '{"ap":600}');
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    const result = await caller.matchmaking.cancel({ mode: 'trivia' });

    expect(result).toEqual({ ok: true, wasQueued: true });
    expect(redis.zset.get('mm:trivia:queue')?.get(USER_ID)).toBeUndefined();
    expect(redis.kv.get(`mm:trivia:meta:${USER_ID}`)).toBeUndefined();
  });

  it('reports wasQueued=false when the user was not in the queue', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 600, is_bot: false },
      error: null,
    });
    const redis = fakeRedis();
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    const result = await caller.matchmaking.cancel({ mode: 'trivia' });

    expect(result).toEqual({ ok: true, wasQueued: false });
  });
});

describe('matchmakingRouter.getStatus', () => {
  it('returns matched with battle id when a matched record exists', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 600, is_bot: false },
      error: null,
    });
    const redis = fakeRedis();
    redis.kv.set(
      `mm:trivia:matched:${USER_ID}`,
      JSON.stringify({
        battleId: 'battle-9',
        role: 'practice',
        opponentIsBot: true,
      }),
    );
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    const result = await caller.matchmaking.getStatus({ mode: 'trivia' });

    expect(result).toEqual({
      status: 'matched',
      battleId: 'battle-9',
      opponentIsBot: true,
    });
  });

  it('returns waiting with meta when the user is queued', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 600, is_bot: false },
      error: null,
    });
    const redis = fakeRedis();
    redis.zset.set('mm:trivia:queue', new Map([[USER_ID, 600]]));
    redis.kv.set(
      `mm:trivia:meta:${USER_ID}`,
      JSON.stringify({ ap: 600, joinedAtMs: 123, mode: 'trivia' }),
    );
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    const result = await caller.matchmaking.getStatus({ mode: 'trivia' });

    expect(result).toEqual({
      status: 'waiting',
      ap: 600,
      joinedAtMs: 123,
    });
  });

  it('returns idle when neither matched nor queued', async () => {
    const { db } = fakeDb('users', {
      data: { current_ap: 600, is_bot: false },
      error: null,
    });
    const redis = fakeRedis();
    const caller = appRouter.createCaller(makeCtx({ db, redis }));

    const result = await caller.matchmaking.getStatus({ mode: 'trivia' });

    expect(result).toEqual({ status: 'idle' });
  });
});
