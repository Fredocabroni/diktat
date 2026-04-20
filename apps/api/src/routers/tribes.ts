// Tribes router. Public `list` (the five starter tribes are world-readable
// via RLS — onboarding loads them before the user signs up). `join` is
// protected and defers to RLS: `tribe_memberships_insert_self` only lets
// an authenticated user insert their own row with weekly_ap=0 and
// is_primary=false, which matches the two valid onboarding cases.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, publicProcedure, router } from '../trpc.js';

export const tribesRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from('tribes')
      .select('id, slug, name, description, manifesto')
      .order('name', { ascending: true });

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load tribes.',
        cause: error,
      });
    }
    return data ?? [];
  }),

  join: protectedProcedure
    .input(z.object({ tribeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from('tribe_memberships')
        .insert({
          user_id: ctx.userId,
          tribe_id: input.tribeId,
          weekly_ap: 0,
          is_primary: false,
        })
        .select('user_id, tribe_id, joined_at')
        .maybeSingle();

      if (error) {
        // 23505 on the composite PK (user_id, tribe_id) — already joined.
        // Treat as idempotent so a double-tap on the tribe button doesn't
        // surface as an error during onboarding.
        if (error.code === '23505') {
          return { userId: ctx.userId, tribeId: input.tribeId, alreadyJoined: true };
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to join tribe.',
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tribe not found.' });
      }
      return {
        userId: data.user_id,
        tribeId: data.tribe_id,
        joinedAt: data.joined_at,
        alreadyJoined: false,
      };
    }),
});
