// Feed router. Phase 3 partial scope: only the `recordShift` mutation
// that writes one row to public.opinion_shifts. RLS policy
// `opinion_shifts_insert_self` (migration 0005) gates the user_id; the
// write goes through `ctx.db` (user-scoped) so the bearer token is the
// authority. The `list` query lands in the follow-up alongside the
// approved 20-topic seed.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';

const positionSchema = z.number().int().min(-2).max(2);

export const feedRouter = router({
  recordShift: protectedProcedure
    .input(
      z.object({
        topicId: z.string().uuid(),
        beforePosition: positionSchema,
        afterPosition: positionSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from('opinion_shifts')
        .insert({
          user_id: ctx.userId,
          topic_id: input.topicId,
          before_position: input.beforePosition,
          after_position: input.afterPosition,
        })
        .select('id, topic_id, before_position, after_position, created_at')
        .maybeSingle();

      if (error) {
        // 23503 fk_violation — the topic id doesn't exist. Surface as
        // NOT_FOUND so the client can clear the card from the local
        // queue without retrying.
        if (error.code === '23503') {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Topic not found.',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record opinion shift.',
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Topic not found.' });
      }
      return {
        id: data.id,
        topicId: data.topic_id,
        beforePosition: data.before_position,
        afterPosition: data.after_position,
        createdAt: data.created_at,
      };
    }),
});
