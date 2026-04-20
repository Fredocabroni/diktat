import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/context.js';
import { appRouter } from '../../src/routers/index.js';
import { makeCtx } from '../helpers.js';

/**
 * Wallet router talks to two tables in `balance` (wallets + users) and one
 * in each of `transactions` / `ghostEarnings`. Build a multi-table fake.
 */
function multiTableDb(
  responses: Record<string, { data: unknown; error: { code?: string; message: string } | null }>,
): {
  db: Context['db'];
  calls: { table: string; ops: { op: string; args: unknown[] }[] }[];
} {
  const calls: { table: string; ops: { op: string; args: unknown[] }[] }[] = [];

  const makeBuilder = (table: string, result: { data: unknown; error: unknown }) => {
    const ops: { op: string; args: unknown[] }[] = [];
    calls.push({ table, ops });
    const builder: Record<string, unknown> = {};
    for (const op of [
      'select',
      'eq',
      'lt',
      'gt',
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
  };

  return { db: db as unknown as Context['db'], calls };
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
  it('returns items + nextCursor when more pages exist', async () => {
    // Stub returns limit + 1 rows so the router emits a cursor.
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
    expect(page.nextCursor).toBe(rows[50]?.created_at);
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
});

describe('walletRouter.ghostEarnings', () => {
  it('sums ghost_credit deltas', async () => {
    const { db, calls } = multiTableDb({
      ap_transactions: {
        data: [{ delta: 5 }, { delta: 12 }, { delta: 3 }],
        error: null,
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.wallet.ghostEarnings();
    expect(result.totalAp).toBe(20);

    // Sanity: filter applied on reason = ghost_credit.
    const reasonCall = calls[0]?.ops.find(
      (op) => op.op === 'eq' && (op.args[0] as string) === 'reason',
    );
    expect(reasonCall?.args).toEqual(['reason', 'ghost_credit']);
  });

  it('returns 0 when there are no ghost credits', async () => {
    const { db } = multiTableDb({
      ap_transactions: { data: [], error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    expect(await caller.wallet.ghostEarnings()).toEqual({ totalAp: 0 });
  });
});
