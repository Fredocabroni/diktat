// Feed router.
//
// `recordShift` mutation: writes one row to public.opinion_shifts. RLS policy
// `opinion_shifts_insert_self` (migration 0005) gates the user_id; the write
// goes through `ctx.db` (user-scoped) so the bearer token is the authority.
//
// `list` query: returns today's Drop (the news_topics row with is_drop=true
// whose drop_at has passed) or the most-recent past Drop if today's hasn't
// fired yet. Length ≤ 1 in default-input mode; forward-compatible with
// archive pagination via { limit, cursor }. RLS read-all is in place on
// news_topics via `news_topics_select_all` (migration 20260420090005:26).

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { mutationLimit, queryLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';

const positionSchema = z.number().int().min(-2).max(2);

const listInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(1),
    // ISO timestamp; rows returned have drop_at <= cursor. Default is the
    // current server time so the no-input call returns "the current Drop".
    // Rejected if it lies in the future — a `cursor=9999-…` call would
    // otherwise return any pre-populated future-dated row the moment
    // drop_publish lands it, before its drop_at arrives. The pipeline
    // today stamps drop_at at INSERT time, but a future curator path
    // (the curation_mode enum already accommodates it) is the kind of
    // writer this guard exists for. The handler also clamps server-side
    // (defense in depth against any future input-schema regression).
    cursor: z
      .string()
      .datetime()
      .optional()
      .refine((v) => v === undefined || Date.parse(v) <= Date.now(), {
        message: 'cursor must not be in the future',
      }),
  })
  .optional();

const TOPIC_SELECT =
  'id, headline, source_title, summary, primary_source_url, category, drop_at, dedup_cluster_id, curation_mode, is_block_exhausted, additional_sources';

interface TopicRow {
  id: string;
  headline: string;
  source_title: string | null;
  summary: string | null;
  primary_source_url: string | null;
  category: string | null;
  drop_at: string | null;
  dedup_cluster_id: string | null;
  curation_mode: string | null;
  is_block_exhausted: boolean;
  additional_sources: unknown;
}

export const feedRouter = router({
  recordShift: protectedProcedure
    // M5 — 10/min per user. One stance per Drop in practice; 10/min
    // is the anti-bot floor.
    .use(mutationLimit('feed.recordShift', { perMin: 10 }))
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

  list: protectedProcedure
    // M5.1 — 60/min per user. Cold read (no client polling), single
    // call site (DropFeedClient on home). 1 DB query. Generous cap
    // for the home-page rapid-navigation case.
    .use(queryLimit('feed.list', { perMin: 60 }))
    .input(listInputSchema)
    .query(async ({ ctx, input }) => {
      // Belt-and-suspenders future-clamp: the input schema already
      // rejects future cursors, but a server-side Math.min closes the
      // window against any later input-schema regression.
      const requestedCursorMs = input?.cursor ? Date.parse(input.cursor) : Date.now();
      const cursor = new Date(Math.min(requestedCursorMs, Date.now())).toISOString();
      const limit = input?.limit ?? 1;

      const { data, error } = (await ctx.db
        .from('news_topics')
        .select(TOPIC_SELECT)
        .eq('is_drop', true)
        .lte('drop_at', cursor)
        .order('drop_at', { ascending: false })
        .limit(limit)) as unknown as {
        data: TopicRow[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load Drop.',
          cause: error,
        });
      }

      const topics = (data ?? []).map((row) => ({
        id: row.id,
        headline: row.headline,
        sourceTitle: row.source_title,
        summary: row.summary,
        primarySourceUrl: row.primary_source_url,
        category: row.category,
        dropAt: row.drop_at,
        dedupClusterId: row.dedup_cluster_id,
        curationMode: row.curation_mode,
        isBlockExhausted: row.is_block_exhausted,
        additionalSources: Array.isArray(row.additional_sources) ? row.additional_sources : [],
      }));

      return { topics };
    }),
});
