// User router. Reads the caller's profile + tier + streak in one round
// trip; updates the handle. RLS enforces self-only access on every read
// and write, so the router only needs to validate input shape.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';

// Handles are stored citext UNIQUE in public.users. Lowercase, alphanumeric
// + underscore, 3–24 chars. Reserve room for civic-themed prefixes without
// running into Twitter's 15-char ceiling for cross-posts.
const handleSchema = z
  .string()
  .min(3, 'Handle must be at least 3 characters.')
  .max(24, 'Handle must be 24 characters or fewer.')
  .regex(/^[a-z0-9_]+$/i, 'Use letters, numbers, and underscores only.')
  .transform((s) => s.toLowerCase());

export const userRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from('users')
      .select(
        `
          id,
          handle,
          display_name,
          avatar_url,
          current_ap,
          tier_id,
          onboarded_at,
          tiers ( id, name, payout_eligible, floor_protected ),
          streaks ( current_length, longest_length, last_action_date, freeze_tokens )
        `,
      )
      .eq('id', ctx.userId)
      .maybeSingle();

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load profile.',
        cause: error,
      });
    }
    if (!data) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
    }

    return data;
  }),

  updateHandle: protectedProcedure
    .input(z.object({ handle: handleSchema }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from('users')
        .update({ handle: input.handle })
        .eq('id', ctx.userId)
        .select('id, handle')
        .maybeSingle();

      if (error) {
        // 23505 = unique_violation on the citext UNIQUE handle index.
        if (error.code === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That handle is already taken.',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update handle.',
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
      }

      return data;
    }),

  completeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from('users')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', ctx.userId)
      .select('id, onboarded_at')
      .maybeSingle();

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to complete onboarding.',
        cause: error,
      });
    }
    if (!data) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found.' });
    }
    return data;
  }),
});
