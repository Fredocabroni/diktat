// Wallet router. AP balance + USD-shown-as-USDC + transactions feed +
// ghost earnings card data. RLS enforces self-only access; the router
// shape converts micros → display USD so the client never has to know
// about the bigint storage unit.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';

const MICROS_PER_USD = 1_000_000n;

function microsToUsd(micros: bigint | number | string | null | undefined): number {
  if (micros == null) return 0;
  const asBig = typeof micros === 'bigint' ? micros : BigInt(micros);
  // Two-decimal display, banker-safe via integer math.
  const cents = (asBig * 100n) / MICROS_PER_USD;
  return Number(cents) / 100;
}

const transactionsInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  // Composite (created_at, id) keyset cursor — tie-stable across
  // rows that share a microsecond. Round-tripped opaquely from the
  // server's nextCursor by `useInfiniteQuery`'s getNextPageParam,
  // so the shape is internal to this router.
  cursor: z
    .object({
      createdAt: z.string().datetime(),
      id: z.string().uuid(),
    })
    .optional(),
});

export const walletRouter = router({
  balance: protectedProcedure.query(async ({ ctx }) => {
    const [walletRes, userRes] = await Promise.all([
      ctx.db
        .from('wallets')
        .select('usdc_balance_micro, display_currency, status')
        .eq('user_id', ctx.userId)
        .maybeSingle(),
      ctx.db.from('users').select('current_ap, tier_id').eq('id', ctx.userId).maybeSingle(),
    ]);

    if (walletRes.error || userRes.error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load wallet.',
        cause: walletRes.error ?? userRes.error,
      });
    }
    if (!walletRes.data || !userRes.data) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet not found.' });
    }

    return {
      currentAp: userRes.data.current_ap,
      tierId: userRes.data.tier_id,
      usdcBalanceMicro: walletRes.data.usdc_balance_micro,
      displayCurrency: walletRes.data.display_currency,
      usd: microsToUsd(walletRes.data.usdc_balance_micro),
      status: walletRes.data.status,
    };
  }),

  transactions: protectedProcedure.input(transactionsInput).query(async ({ ctx, input }) => {
    let query = ctx.db
      .from('ap_transactions')
      .select('id, delta, balance_after, reason, ref_type, ref_id, created_at')
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(input.limit + 1);

    if (input.cursor) {
      // Composite (created_at, id) keyset: strictly-before in
      // (created_at desc, id desc) order. The two-clause OR mirrors the
      // SQL tuple comparison (created_at, id) < (cursor.createdAt,
      // cursor.id). PostgREST renders top-level OR alternatives
      // comma-separated; AND-groups wrap in `and(...)`. The composite
      // index `ap_tx_user_recent_idx (user_id, created_at desc, id desc)`
      // (migration 20260618220000) supports this seek index-only.
      query = query.or(
        `created_at.lt.${input.cursor.createdAt},` +
          `and(created_at.eq.${input.cursor.createdAt},id.lt.${input.cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load transactions.',
        cause: error,
      });
    }

    const rows = data ?? [];
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const lastItem = items[items.length - 1];
    const nextCursor =
      hasMore && lastItem ? { createdAt: lastItem.created_at, id: lastItem.id } : null;

    return { items, nextCursor };
  }),

  ghostEarnings: protectedProcedure.query(async ({ ctx }) => {
    // Aggregate pushed into a SECURITY INVOKER SQL function
    // (migration 20260618220000). Postgres sums ghost_credit deltas
    // for auth.uid() inside the DB; only a single bigint crosses the
    // wire. RLS scopes the read to the caller via ap_tx_select_self.
    const { data, error } = await ctx.db.rpc('wallet_ghost_earnings');

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load ghost earnings.',
        cause: error,
      });
    }

    // Supabase-js + PostgREST may return the bigint as string or
    // number depending on adapter; coerce defensively to preserve
    // the existing `{ totalAp: number }` contract.
    return { totalAp: Number(data ?? 0) };
  }),
});
