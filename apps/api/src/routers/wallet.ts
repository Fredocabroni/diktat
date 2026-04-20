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
  cursor: z.string().datetime().optional(),
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
      .limit(input.limit + 1);

    if (input.cursor) query = query.lt('created_at', input.cursor);

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
    const nextCursor = hasMore ? (rows[input.limit]?.created_at ?? null) : null;

    return { items, nextCursor };
  }),

  ghostEarnings: protectedProcedure.query(async ({ ctx }) => {
    // Ghost credits accumulate for tiers 0–2 (computed by the AP engine).
    // We sum them here for the wallet badge; the engine has already capped
    // and gated eligibility at write time, so a simple aggregate is safe.
    const { data, error } = await ctx.db
      .from('ap_transactions')
      .select('delta')
      .eq('user_id', ctx.userId)
      .eq('reason', 'ghost_credit');

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load ghost earnings.',
        cause: error,
      });
    }

    const totalAp = (data ?? []).reduce((acc, row) => acc + row.delta, 0);
    return { totalAp };
  }),
});
