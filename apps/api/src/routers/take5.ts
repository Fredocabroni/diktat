// Take 5 router. Backend for the /take5 archive surface (P4 PR A).
//
// ARCHIVE-ONLY launch — no evergreen bank, no admin surface (deferred).
// The stack simply renders fewer than 5 cards when the 7-day archive
// is thin; the frontend treats that as a valid state rather than a
// degraded one. The eventual evergreen branch is a separate PR.
//
// `getStack` returns up to 5 recent Drops the caller hasn't yet
// stanced on, newest first. "Stanced on" is read from `opinion_shifts`
// (one row per user+topic+change-of-mind); a Drop the user has already
// stanced on — via feed.recordShift OR take5.recordShift — never
// reappears in the Take 5 stack.
//
// `recordShift` mutation delegates to the `record_take5_shift`
// SECURITY DEFINER RPC (migration 20261105000000). That RPC enforces
// the per-ET-day cap of 5 cards and chains into `record_opinion_shift`
// so the Take 5 streak trigger fires exactly once per distinct topic
// per local day (see migration 20261011000000). We never touch
// `opinion_shifts` or `take5_sessions` directly from the router.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { mutationLimit, queryLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';

const positionSchema = z.number().int().min(-2).max(2);

// Mirror the fields the Drop card renders. Kept narrow so the Take 5
// payload is small (we fetch up to 5 rows + their stance join).
const CARD_SELECT =
  'id, headline, source_title, summary, primary_source_url, category, drop_at, dedup_cluster_id, additional_sources, fact_explainer';

export interface CardRow {
  id: string;
  headline: string;
  source_title: string | null;
  summary: string | null;
  primary_source_url: string | null;
  category: string | null;
  drop_at: string | null;
  dedup_cluster_id: string | null;
  additional_sources: unknown;
  fact_explainer: unknown;
}

export const take5Router = router({
  // Returns up to 5 Drops (today's if present + past Drops within 7 ET
  // days, newest first) that the caller has not yet stanced on. The
  // stack length is 0..5; `/take5` renders whatever it gets.
  getStack: protectedProcedure
    .use(queryLimit('take5.getStack', { perMin: 60 }))
    .query(async ({ ctx }) => {
      // 7-day archive window. We compute the lower bound in UTC — the
      // ET anchor is a soft contract (7 "days" of archive, not an
      // exact ET-midnight boundary). The upper bound is NOW (we never
      // show a future-dated Drop even if one somehow landed).
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Over-fetch: we filter stanced topics in TS below, so pulling
      // more than 5 raw rows lets the final list still reach 5 when
      // the user has stanced on some of the recent Drops. 25 is a
      // generous ceiling at the current cadence (one Drop/day → ~7
      // Drops in the window) and bounded against a hypothetical burst.
      const RAW_LIMIT = 25;

      const { data: topicRows, error: topicErr } = (await ctx.db
        .from('news_topics')
        .select(CARD_SELECT)
        .eq('is_drop', true)
        .gte('drop_at', cutoff)
        .lte('drop_at', new Date().toISOString())
        .order('drop_at', { ascending: false })
        .limit(RAW_LIMIT)) as unknown as {
        data: CardRow[] | null;
        error: { message: string } | null;
      };
      if (topicErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load Take 5 stack.',
          cause: new Error('topic_load'),
        });
      }
      const topics = topicRows ?? [];
      if (topics.length === 0) {
        return { cards: [] as CardRow[] };
      }

      // Fetch the caller's stances on any of these topics in ONE
      // query. RLS on `opinion_shifts` (via is_self) scopes this to
      // the caller's rows only; we do NOT trust client-supplied
      // user_id here. The `.in()` is bounded by RAW_LIMIT above, so
      // the query-string budget is predictable.
      const topicIds = topics.map((t) => t.id);
      const { data: shiftRows, error: shiftErr } = (await ctx.db
        .from('opinion_shifts')
        .select('topic_id')
        .eq('user_id', ctx.userId)
        .in('topic_id', topicIds)) as unknown as {
        data: { topic_id: string }[] | null;
        error: { message: string } | null;
      };
      if (shiftErr) {
        // Fail CLOSED here: if we can't determine which topics the
        // user already stanced on, we must NOT return the stack —
        // showing already-stanced cards would be a worse UX than
        // showing nothing. The frontend treats an error as a quiet
        // "no cards" state (same shape as a thin archive).
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load Take 5 stack.',
          cause: new Error('stance_load'),
        });
      }
      const stanced = new Set((shiftRows ?? []).map((s) => s.topic_id));

      const cards = topics.filter((t) => !stanced.has(t.id)).slice(0, 5);
      return { cards };
    }),

  // Records a Take 5 stance. Delegates to the SECURITY DEFINER RPC;
  // the RPC enforces the per-ET-day cap of 5 cards AND fires the
  // Take 5 streak trigger via its inner call to record_opinion_shift.
  recordShift: protectedProcedure
    // 10/min matches feed.recordShift. Honest usage is <=5 taps in a
    // short burst at session start — 10/min is the anti-bot floor.
    .use(mutationLimit('take5.recordShift', { perMin: 10 }))
    .input(
      z.object({
        topicId: z.string().uuid(),
        afterPosition: positionSchema,
        // Per-tap idempotency key, same semantics as
        // feed.recordShift's clientKey (see migration
        // 20260930000000). Optional during the rollout window.
        clientKey: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db.rpc('record_take5_shift', {
        p_topic_id: input.topicId,
        p_after_position: input.afterPosition,
        p_client_key: input.clientKey ?? undefined,
      });

      if (error) {
        // Map RPC sqlstate → tRPC code. The `cause` carries only the
        // sqlstate; the raw PostgrestError's message/details/hint
        // (which can echo UUIDs or constraint names) never reaches
        // the tRPC wire response.
        const code = error.code;
        if (code === '54000') {
          // Take 5 daily cap OR rolling-24h cap in record_opinion_shift.
          // Both are rate limits by shape — client should surface
          // a quiet "come back tomorrow" rather than retry.
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Take 5 limit reached for today.',
            cause: new Error(code),
          });
        }
        if (code === 'P0002') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Topic not found.' });
        }
        if (code === '22023') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid stance.',
            cause: new Error(code),
          });
        }
        if (code === '28000') {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Not authenticated.',
            cause: new Error(code),
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record Take 5 stance.',
          cause: new Error(code ?? 'db_error'),
        });
      }

      // The RPC returns a setof — supabase-js materialises it as an
      // array. We only ever return one row per call (one shift ↔
      // one take5_sessions row).
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record Take 5 stance.',
          cause: new Error('rpc_null_result'),
        });
      }

      return {
        shiftId: row.shift_id,
        topicId: row.topic_id,
        etDay: row.et_day,
        cardsToday: row.cards_today,
      };
    }),
});
