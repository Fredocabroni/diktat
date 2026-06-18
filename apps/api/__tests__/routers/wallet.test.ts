import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { makeCtx } from '../helpers.js';

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
