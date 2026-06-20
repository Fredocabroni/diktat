import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import type { Context, RedisClient } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { fakeRedis, makeCtx } from '../helpers.js';

/**
 * Wallet router talks to two tables in `balance` (wallets + users), one
 * table in `transactions`, and one RPC (`wallet_ghost_earnings`) in
 * `ghostEarnings`. Build a multi-table + rpc fake.
 */
function multiTableDb(
  responses: Record<string, { data: unknown; error: { code?: string; message: string } | null }>,
  rpcResponses: Record<
    string,
    { data: unknown; error: { code?: string; message: string } | null }
  > = {},
): {
  db: Context['db'];
  calls: { table: string; ops: { op: string; args: unknown[] }[] }[];
  rpcCalls: { fn: string; args: unknown }[];
} {
  const calls: { table: string; ops: { op: string; args: unknown[] }[] }[] = [];
  const rpcCalls: { fn: string; args: unknown }[] = [];

  const makeBuilder = (table: string, result: { data: unknown; error: unknown }) => {
    const ops: { op: string; args: unknown[] }[] = [];
    calls.push({ table, ops });
    const builder: Record<string, unknown> = {};
    for (const op of [
      'select',
      'eq',
      'lt',
      'gt',
      'or',
      'order',
      'limit',
      'update',
      'insert',
      'upsert',
      'delete',
    ]) {
      builder[op] = (...args: unknown[]) => {
        ops.push({ op, args });
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(result);
    builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result));
    return builder;
  };

  const db = {
    from: (table: string) => {
      const r = responses[table];
      if (!r) throw new Error(`multiTableDb: no response stubbed for "${table}"`);
      return makeBuilder(table, r);
    },
    rpc: (fn: string, args?: unknown) => {
      const r = rpcResponses[fn];
      if (!r) throw new Error(`multiTableDb: no rpc stubbed for "${fn}"`);
      rpcCalls.push({ fn, args });
      return Promise.resolve(r);
    },
  };

  return { db: db as unknown as Context['db'], calls, rpcCalls };
}

describe('walletRouter.balance', () => {
  it('returns AP, USDC micros, and shown-USD together', async () => {
    const { db } = multiTableDb({
      wallets: {
        data: {
          usdc_balance_micro: 12_500_000,
          display_currency: 'USD',
          status: 'active',
        },
        error: null,
      },
      users: { data: { current_ap: 4250, tier_id: 5 }, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.wallet.balance();
    expect(result.currentAp).toBe(4250);
    expect(result.tierId).toBe(5);
    expect(result.usdcBalanceMicro).toBe(12_500_000);
    expect(result.usd).toBe(12.5);
    expect(result.status).toBe('active');
  });

  it('NOT_FOUND when wallet row missing', async () => {
    const { db } = multiTableDb({
      wallets: { data: null, error: null },
      users: { data: { current_ap: 100, tier_id: 0 }, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.wallet.balance()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('walletRouter.transactions', () => {
  it('returns items + composite {createdAt,id} nextCursor when more pages exist', async () => {
    // Stub returns limit + 1 rows so the router emits a cursor. The
    // nextCursor is built from items[items.length-1] (the LAST item of
    // the trimmed page), not rows[limit] — that way the next page's
    // composite-OR filter starts strictly before the page boundary.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `tx-${i}`,
      delta: 10,
      balance_after: 100 + i * 10,
      reason: 'battle_win' as const,
      ref_type: null,
      ref_id: null,
      created_at: `2026-04-20T10:${String(i).padStart(2, '0')}:00Z`,
    }));
    const { db } = multiTableDb({
      ap_transactions: { data: rows, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const page = await caller.wallet.transactions({ limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toEqual({
      createdAt: rows[49]!.created_at,
      id: rows[49]!.id,
    });
  });

  it('omits cursor on the last page', async () => {
    const { db } = multiTableDb({
      ap_transactions: {
        data: [
          {
            id: 'tx-1',
            delta: 10,
            balance_after: 110,
            reason: 'battle_win',
            ref_type: null,
            ref_id: null,
            created_at: '2026-04-20T10:00:00Z',
          },
        ],
        error: null,
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const page = await caller.wallet.transactions({ limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('emits the composite-OR filter when a cursor is provided', async () => {
    const { db, calls } = multiTableDb({
      ap_transactions: { data: [], error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const cursor = {
      createdAt: '2026-04-20T10:30:00Z',
      id: '11111111-1111-4111-8111-111111111111',
    };
    await caller.wallet.transactions({ limit: 50, cursor });

    // Expect the .or() call mirroring (created_at, id) < (cursor)
    // composite tuple comparison.
    const orCall = calls[0]?.ops.find((op) => op.op === 'or');
    expect(orCall?.args).toEqual([
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    ]);

    // And the secondary `id desc` order key must be present alongside
    // `created_at desc` so the index seeks tie-stably.
    const orderCalls =
      calls[0]?.ops.filter((op) => op.op === 'order').map((op) => op.args[0]) ?? [];
    expect(orderCalls).toEqual(['created_at', 'id']);
  });

  // -------------------------------------------------------------------------
  // PR #65 round-3 MEDIUM-1 — cursor.createdAt future-date clamp.
  //
  // The composite (created_at, id) keyset cursor accepts any RFC3339
  // datetime. Without a future-date clamp, a caller passing
  // `9999-12-31T23:59:59Z` would widen the seek window to "everything
  // before the heat death of the universe" — the keyset pagination
  // semantics collapse to a forward-scan, and RLS-bounded self-data
  // becomes a full-table read for the caller's user. Mirror the
  // `feed.list` cursor pattern with `z.string().datetime().refine(...)`.
  //
  // Past + present timestamps continue to pass; future timestamps
  // throw at the Zod parse layer before the resolver runs.
  // -------------------------------------------------------------------------
  it('rejects a future cursor.createdAt at the Zod parse layer', async () => {
    const { db } = multiTableDb({ ap_transactions: { data: [], error: null } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const futureCursor = {
      createdAt: '9999-12-31T23:59:59Z',
      id: '11111111-1111-4111-8111-111111111111',
    };

    await expect(caller.wallet.transactions({ limit: 50, cursor: futureCursor })).rejects.toThrow(
      /cursor\.createdAt must not be in the future/,
    );
  });

  it('accepts a past cursor.createdAt (one year ago is valid)', async () => {
    const { db } = multiTableDb({ ap_transactions: { data: [], error: null } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const oneYearAgoMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const pastCursor = {
      createdAt: new Date(oneYearAgoMs).toISOString(),
      id: '11111111-1111-4111-8111-111111111111',
    };

    await expect(caller.wallet.transactions({ limit: 50, cursor: pastCursor })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('accepts a near-now cursor.createdAt (yesterday)', async () => {
    // Edge-of-window check: a cursor from yesterday must still clear
    // the clamp — confirms the predicate is `<= now`, not `< now` or
    // any stricter form that would refuse legitimate recent paginates.
    const { db } = multiTableDb({ ap_transactions: { data: [], error: null } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const yesterdayMs = Date.now() - 24 * 60 * 60 * 1000;
    const recentCursor = {
      createdAt: new Date(yesterdayMs).toISOString(),
      id: '11111111-1111-4111-8111-111111111111',
    };

    await expect(caller.wallet.transactions({ limit: 50, cursor: recentCursor })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('walletRouter.ghostEarnings', () => {
  it('calls wallet_ghost_earnings() RPC and returns its bigint sum', async () => {
    const { db, rpcCalls } = multiTableDb({}, { wallet_ghost_earnings: { data: 20, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.wallet.ghostEarnings();
    expect(result).toEqual({ totalAp: 20 });

    // Sanity: the procedure invoked the RPC, not a table read.
    expect(rpcCalls).toEqual([{ fn: 'wallet_ghost_earnings', args: undefined }]);
  });

  it('coerces bigint-as-string to number (Supabase-js may serialize)', async () => {
    const { db } = multiTableDb(
      {},
      // Mirrors the wire-shape where bigint comes back as a string.
      { wallet_ghost_earnings: { data: '42' as unknown as number, error: null } },
    );
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.wallet.ghostEarnings()).toEqual({ totalAp: 42 });
  });

  it('returns 0 when the RPC sums to null/0 (empty ghost ledger)', async () => {
    const { db } = multiTableDb({}, { wallet_ghost_earnings: { data: 0, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.wallet.ghostEarnings()).toEqual({ totalAp: 0 });
  });
});

// ---------------------------------------------------------------------------
// M5.1 wallet read-tier wiring — fat-finger guard.
//
// Each test drives the live `walletRouter` via createCaller with a fakeRedis
// whose Lua return value is fixed at (cap, ttl). The middleware computes
// `allowed = current <= limit` JS-side from the returned cur, so a return
// of `[cap, ttl]` → ALLOWED and `[cap+1, ttl]` → 429. By pinning the
// boundary at the wired cap value (60 / 120 / 60), a fat-finger swap
// (transactions wired at 60 instead of 120, balance wired at 120, etc.)
// fails immediately: `[120, ttl]` against a 60-capped procedure denies
// instead of allowing.
//
// Also asserts the rl:q:wallet.<proc>:u:user-123:<window> key shape so
// a future refactor that drops the `q` tier label or misnames the
// procedure slug breaks the test rather than silently reshaping the
// counter namespace.
// ---------------------------------------------------------------------------

interface WiredCallSite {
  readonly name: 'wallet.balance' | 'wallet.transactions' | 'wallet.ghostEarnings';
  readonly cap: number;
  readonly fire: (caller: ReturnType<typeof appRouter.createCaller>) => Promise<unknown>;
  readonly buildDb: () => Context['db'];
}

function balanceDb(): Context['db'] {
  return multiTableDb({
    wallets: {
      data: { usdc_balance_micro: 1_000_000, display_currency: 'USD', status: 'active' },
      error: null,
    },
    users: { data: { current_ap: 100, tier_id: 0 }, error: null },
  }).db;
}
function transactionsDb(): Context['db'] {
  return multiTableDb({ ap_transactions: { data: [], error: null } }).db;
}
function ghostEarningsDb(): Context['db'] {
  return multiTableDb({}, { wallet_ghost_earnings: { data: 0, error: null } }).db;
}

const WIRED: ReadonlyArray<WiredCallSite> = [
  {
    name: 'wallet.balance',
    cap: 60,
    fire: (c) => c.wallet.balance(),
    buildDb: balanceDb,
  },
  {
    name: 'wallet.transactions',
    cap: 120,
    fire: (c) => c.wallet.transactions({ limit: 50 }),
    buildDb: transactionsDb,
  },
  {
    name: 'wallet.ghostEarnings',
    cap: 60,
    fire: (c) => c.wallet.ghostEarnings(),
    buildDb: ghostEarningsDb,
  },
];

describe('walletRouter — M5.1 queryLimit wiring (fat-finger guard)', () => {
  for (const site of WIRED) {
    it(`${site.name} wired at exactly ${site.cap}/min — [cap] allowed, [cap+1] denied`, async () => {
      // 1) At the cap → middleware allows; resolver runs to completion.
      const redisAllow = fakeRedis();
      redisAllow.evalReturn = [site.cap, 60];
      const ctxAllow = makeCtx({
        db: site.buildDb(),
        redis: redisAllow as unknown as RedisClient,
      });
      const callerAllow = appRouter.createCaller(ctxAllow);
      await expect(site.fire(callerAllow)).resolves.toBeDefined();

      // 2) One over the cap → middleware throws TOO_MANY_REQUESTS.
      //    If a fat-finger swap landed (e.g. wallet.transactions wired
      //    at 60), this assertion flips: a [cap+1] of the EXPECTED cap
      //    would slip through against the wrong wired value.
      const redisDeny = fakeRedis();
      redisDeny.evalReturn = [site.cap + 1, 60];
      const ctxDeny = makeCtx({
        db: site.buildDb(),
        redis: redisDeny as unknown as RedisClient,
      });
      const callerDeny = appRouter.createCaller(ctxDeny);
      await expect(site.fire(callerDeny)).rejects.toBeInstanceOf(TRPCError);
      await expect(site.fire(callerDeny)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    });

    it(`${site.name} emits the rl:q:${site.name}:u:user-123:<window> key shape`, async () => {
      const redis = fakeRedis();
      redis.evalReturn = [1, 60];
      const ctx = makeCtx({
        db: site.buildDb(),
        redis: redis as unknown as RedisClient,
      });
      const caller = appRouter.createCaller(ctx);
      await site.fire(caller);

      // The very first eval on this fakeRedis must be the queryLimit
      // gate (no upstream middleware on these procedures touches Redis
      // pre-resolver). Pin both the tier and the procedure slug.
      expect(redis.evalCalls.length).toBeGreaterThanOrEqual(1);
      const key = redis.evalCalls[0]!.keys[0]!;
      const expected = new RegExp(`^rl:q:${site.name.replace('.', '\\.')}:u:user-123:\\d+$`);
      expect(key).toMatch(expected);
      // Cross-tier guard: never the mut/ai/pub/global namespaces.
      expect(key).not.toMatch(/^rl:(mut|ai|pub|global):/);
    });
  }
});
