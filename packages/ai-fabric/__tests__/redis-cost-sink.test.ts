import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetLedgerForTests,
  buildUpstashCostSink,
  getDailySpend,
  hydrateLedgerFromSink,
  recordSpend,
  setCostSink,
  type UpstashLike,
} from '../src/index.js';

interface FakeStore {
  store: Map<string, number>;
  client: UpstashLike;
  expires: { key: string; seconds: number }[];
}

function buildFake(seed: Record<string, number> = {}): FakeStore {
  const store = new Map<string, number>(Object.entries(seed));
  const expires: { key: string; seconds: number }[] = [];
  const client: UpstashLike = {
    incrbyfloat: vi.fn(async (key: string, inc: number) => {
      const next = (store.get(key) ?? 0) + inc;
      store.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      expires.push({ key, seconds });
      return 1;
    }),
    get: vi.fn(async (key: string) => {
      const v = store.get(key);
      return v === undefined ? null : (String(v) as never);
    }),
  };
  return { store, client, expires };
}

beforeEach(() => {
  __resetLedgerForTests();
});

afterEach(() => {
  __resetLedgerForTests();
});

describe('buildUpstashCostSink', () => {
  it('writes per-task and total counters with TTL refresh on recordSpend', async () => {
    const fake = buildFake();
    const sink = buildUpstashCostSink(fake.client);

    await sink.recordSpend('2026-04-25', 'trivia_gen', 1.25);

    expect(fake.store.get('ai_cost:2026-04-25:total')).toBeCloseTo(1.25, 6);
    expect(fake.store.get('ai_cost:2026-04-25:task:trivia_gen')).toBeCloseTo(1.25, 6);
    expect(fake.expires).toHaveLength(2);
    for (const e of fake.expires) {
      expect(e.seconds).toBe(86_400 * 2);
    }
  });

  it('aggregates across multiple recordSpend calls', async () => {
    const fake = buildFake();
    const sink = buildUpstashCostSink(fake.client);

    await sink.recordSpend('2026-04-25', 'trivia_gen', 0.5);
    await sink.recordSpend('2026-04-25', 'trivia_gen', 0.75);
    await sink.recordSpend('2026-04-25', 'code_gen', 2);

    expect(fake.store.get('ai_cost:2026-04-25:total')).toBeCloseTo(3.25, 6);
    expect(fake.store.get('ai_cost:2026-04-25:task:trivia_gen')).toBeCloseTo(1.25, 6);
    expect(fake.store.get('ai_cost:2026-04-25:task:code_gen')).toBe(2);
  });

  it('skips zero-or-negative spend (defense against rounding)', async () => {
    const fake = buildFake();
    const sink = buildUpstashCostSink(fake.client);

    await sink.recordSpend('2026-04-25', 'trivia_gen', 0);
    await sink.recordSpend('2026-04-25', 'trivia_gen', -0.0001);

    expect(fake.store.size).toBe(0);
    expect(fake.client.incrbyfloat).not.toHaveBeenCalled();
  });

  it('loadDailySpend returns zero when no keys exist', async () => {
    const fake = buildFake();
    const sink = buildUpstashCostSink(fake.client);

    const snapshot = await sink.loadDailySpend('2026-04-25');

    expect(snapshot.total).toBe(0);
    expect(snapshot.byTask).toEqual({});
  });

  it('loadDailySpend reads back what recordSpend wrote', async () => {
    const fake = buildFake();
    const sink = buildUpstashCostSink(fake.client);

    await sink.recordSpend('2026-04-25', 'trivia_gen', 1.25);
    await sink.recordSpend('2026-04-25', 'code_gen', 2);

    const snapshot = await sink.loadDailySpend('2026-04-25');

    expect(snapshot.total).toBeCloseTo(3.25, 6);
    expect(snapshot.byTask.trivia_gen).toBeCloseTo(1.25, 6);
    expect(snapshot.byTask.code_gen).toBe(2);
  });
});

describe('cost.ts ↔ sink wiring', () => {
  it('recordSpend dispatches to the configured sink (fire-and-forget)', async () => {
    const fake = buildFake();
    setCostSink(buildUpstashCostSink(fake.client));

    recordSpend('trivia_gen', 0.5);

    // Yield once so the fire-and-forget promise can settle.
    await Promise.resolve();
    await Promise.resolve();

    const utcDay = getDailySpend().utcDay;
    expect(fake.store.get(`ai_cost:${utcDay}:total`)).toBeCloseTo(0.5, 6);
    expect(fake.store.get(`ai_cost:${utcDay}:task:trivia_gen`)).toBeCloseTo(0.5, 6);
  });

  it('hydrateLedgerFromSink seeds the in-memory ledger from Redis', async () => {
    const utcDay = new Date().toISOString().slice(0, 10);
    const fake = buildFake({
      [`ai_cost:${utcDay}:total`]: 12.5,
      [`ai_cost:${utcDay}:task:code_gen`]: 8,
      [`ai_cost:${utcDay}:task:trivia_gen`]: 2,
      [`ai_cost:${utcDay}:task:news_rank`]: 2.5,
    });
    setCostSink(buildUpstashCostSink(fake.client));

    await hydrateLedgerFromSink();

    const snapshot = getDailySpend();
    expect(snapshot.total).toBeCloseTo(12.5, 6);
    expect(snapshot.byTask.code_gen).toBe(8);
    expect(snapshot.byTask.trivia_gen).toBe(2);
    expect(snapshot.byTask.news_rank).toBe(2.5);
  });

  it('sink failures are swallowed (fire-and-forget never breaks the caller)', async () => {
    const sinkErr = new Error('redis down');
    setCostSink({
      recordSpend: vi.fn(async () => {
        throw sinkErr;
      }),
      loadDailySpend: vi.fn(async () => ({ byTask: {}, total: 0 })),
    });

    expect(() => recordSpend('trivia_gen', 1)).not.toThrow();

    // Allow the unhandled-promise-catch branch to run.
    await Promise.resolve();
    await Promise.resolve();
  });
});
