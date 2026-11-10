// Comments router. All writes route through SECURITY DEFINER RPCs
// (migration 20261126000000) per the CLAUDE.md "RLS vs SECURITY
// DEFINER RPC" rule — the SQL enforces the locked-stance gate, the
// one-level reply rule, the body length cap, and the rolling-24h
// 60-per-user cap. The tRPC layer adds a per-minute mutation rate
// limit (5/min for create, 60/min for toggleLike) on top. There is
// NO client-side *_insert_self policy on comments or comment_likes.
//
// Read path. `list` and `listReplies` go through `ctx.db` (user-
// scoped Supabase client) so RLS enforces the "authenticated only"
// SELECT policy on public.comments. Soft-deleted rows ARE returned
// for structural integrity but their body is cleared in SQL by the
// delete RPC, and the handler blanks it again on the read side as
// defense in depth. `liked_by_me` is computed with a scoped SELECT
// against public.comment_likes; the migration's `comment_likes_select_own`
// policy restricts that SELECT to the caller's own rows, so every row
// returned already satisfies `user_id = auth.uid()`.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { mutationLimit, queryLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';

const BODY_MAX = 500;
const LIST_PAGE_SIZE = 20;
const REPLY_PAGE_SIZE = 20;
const INLINE_REPLY_PREVIEW = 3;

const SORT_SCHEMA = z.enum(['top', 'new']).default('new');

interface CommentRow {
  readonly id: string;
  readonly topic_id: string;
  readonly parent_id: string | null;
  readonly user_id: string;
  readonly handle: string;
  readonly stance: string;
  readonly body: string;
  readonly deleted_at: string | null;
  readonly like_count: number;
  // Denormalised by the comments_reply_recount trigger. Optional so
  // reply rows (which never carry replies) and older fixtures type-check.
  readonly reply_count?: number;
  readonly created_at: string;
}

export interface CommentOut {
  readonly id: string;
  readonly topicId: string;
  readonly parentId: string | null;
  readonly handle: string;
  readonly stance: 'agree' | 'disagree';
  readonly body: string;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly likeCount: number;
  readonly likedByMe: boolean;
  readonly isMine: boolean;
}

function toCommentOut(row: CommentRow, userId: string, likedSet: Set<string>): CommentOut {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    topicId: row.topic_id,
    parentId: row.parent_id,
    handle: row.handle,
    // The SQL CHECK constraint gates stance to 'agree'|'disagree', so
    // the cast is sound at runtime.
    stance: row.stance as 'agree' | 'disagree',
    // Blank the body on deleted rows — defence in depth. The delete
    // RPC already clears it; this stops a bad write (e.g. a direct
    // service-role update that forgets to clear) from leaking.
    body: deleted ? '' : row.body,
    deleted,
    createdAt: row.created_at,
    likeCount: row.like_count,
    likedByMe: likedSet.has(row.id),
    isMine: row.user_id === userId,
  };
}

/** Pull the set of comment ids (from `allIds`) that `userId` has
 *  liked. Defensive: the fetch is bounded by the caller's already-
 *  bounded id list; a failure logs a short code and the handler
 *  continues with an empty set (likedByMe falls to false). */
async function fetchLikedSet(
  db: { from: (t: string) => unknown },
  userId: string,
  allIds: readonly string[],
): Promise<Set<string>> {
  if (allIds.length === 0) return new Set();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (db as any)
    .from('comment_likes')
    .select('comment_id')
    .eq('user_id', userId)
    .in('comment_id', allIds);
  const { data, error } = (await q) as {
    data: Array<{ comment_id: string }> | null;
    error: { code?: string; message: string } | null;
  };
  if (error) {
    console.warn(
      JSON.stringify({
        event: 'comments.liked_set_lookup_failed',
        code: error.code ?? 'unknown',
      }),
    );
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.comment_id));
}

function cursorFromRow(row: CommentRow): string {
  return row.created_at;
}

export const commentsRouter = router({
  // Non-deleted top-level comment count for a topic. Used by the UI
  // affordance "comments · N" under the vote/split area so the toggle
  // can render the count before the panel is expanded. The query is a
  // single count aggregate on `(topic_id, parent_id is null,
  // deleted_at is null)` — covered by `comments_topic_created_idx`;
  // negligible per-call cost.
  count: protectedProcedure
    .use(queryLimit('comments.count', { perMin: 120 }))
    .input(z.object({ topicId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count, error } = (await (ctx.db as any)
        .from('comments')
        .select('id', { count: 'exact', head: true })
        .eq('topic_id', input.topicId)
        .is('parent_id', null)
        .is('deleted_at', null)) as {
        count: number | null;
        error: { code?: string; message: string } | null;
      };
      if (error) {
        console.warn(
          JSON.stringify({ event: 'comments.count_failed', code: error.code ?? 'unknown' }),
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load comment count.',
          cause: new Error(error.code ?? 'db_error'),
        });
      }
      return { count: count ?? 0 };
    }),

  // Top-level list for a topic, with up to INLINE_REPLY_PREVIEW
  // replies inlined under each comment plus a total reply count so
  // the client can decide to render "see N more replies" affordances.
  list: protectedProcedure
    .use(queryLimit('comments.list', { perMin: 60 }))
    .input(
      z.object({
        topicId: z.string().uuid(),
        sort: SORT_SCHEMA,
        // ISO timestamp; keyset pagination. Refuse future cursors so
        // a `cursor=9999-...` call cannot preempt newly-written rows.
        cursor: z
          .string()
          .datetime()
          .optional()
          .refine((v) => v === undefined || Date.parse(v) <= Date.now(), {
            message: 'cursor must not be in the future',
          }),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Top-level comments: parent_id is NULL; page by the chosen sort.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (ctx.db as any)
        .from('comments')
        .select(
          'id, topic_id, parent_id, user_id, handle, stance, body, deleted_at, like_count, reply_count, created_at',
        )
        .eq('topic_id', input.topicId)
        .is('parent_id', null)
        .limit(LIST_PAGE_SIZE + 1);
      if (input.sort === 'new') {
        q = q.order('created_at', { ascending: false });
        if (input.cursor) q = q.lt('created_at', input.cursor);
      } else {
        // 'top' — like_count desc, created_at desc as stable tiebreak.
        // Filter soft-deleted rows: a tombstone with historical likes
        // must not out-rank live comments on top-sort. The migration's
        // partial index `comments_topic_like_count_idx` is scoped to
        // the same `deleted_at is null` predicate; keep these aligned.
        q = q
          .is('deleted_at', null)
          .order('like_count', { ascending: false })
          .order('created_at', { ascending: false });
        // `top` uses the created_at cursor only as a secondary bound;
        // keyset-perfect pagination on (like_count, created_at) is
        // deferred — this is good enough for V1 where there won't be
        // >>20 comments on a single topic yet.
        if (input.cursor) q = q.lt('created_at', input.cursor);
      }
      const { data, error } = (await q) as {
        data: CommentRow[] | null;
        error: { code?: string; message: string } | null;
      };
      if (error) {
        console.warn(
          JSON.stringify({ event: 'comments.list_failed', code: error.code ?? 'unknown' }),
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load comments.',
          cause: new Error(error.code ?? 'db_error'),
        });
      }
      const rows = data ?? [];
      const hasMore = rows.length > LIST_PAGE_SIZE;
      const pageRows = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

      // Inline reply previews. reply_count is denormalised on the parent
      // row (comments_reply_recount trigger), so we only fetch preview
      // rows for parents that have replies, each capped at
      // INLINE_REPLY_PREVIEW. Worst case per call: LIST_PAGE_SIZE small
      // bounded queries in parallel; the total row count is a constant
      // (LIST_PAGE_SIZE * INLINE_REPLY_PREVIEW) no matter how many
      // replies a popular comment accumulates.
      const parentsWithReplies = pageRows.filter((r) => (r.reply_count ?? 0) > 0);
      const previewResults = await Promise.all(
        parentsWithReplies.map(async (parent) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: rData, error: rErr } = (await (ctx.db as any)
            .from('comments')
            .select(
              'id, topic_id, parent_id, user_id, handle, stance, body, deleted_at, like_count, created_at',
            )
            .eq('parent_id', parent.id)
            .order('created_at', { ascending: true })
            .limit(INLINE_REPLY_PREVIEW)) as {
            data: CommentRow[] | null;
            error: { code?: string; message: string } | null;
          };
          if (rErr) {
            console.warn(
              JSON.stringify({
                event: 'comments.replies_lookup_failed',
                code: rErr.code ?? 'unknown',
              }),
            );
            return [parent.id, [] as CommentRow[]] as const;
          }
          return [parent.id, (rData ?? []).slice(0, INLINE_REPLY_PREVIEW)] as const;
        }),
      );
      const repliesByParent: Record<string, CommentRow[]> = Object.fromEntries(previewResults);
      const replyRows: CommentRow[] = previewResults.flatMap(([, rows]) => rows);

      const everyRowId = [...pageRows.map((r) => r.id), ...replyRows.map((r) => r.id)];
      const likedSet = await fetchLikedSet(
        ctx.db as unknown as { from: (t: string) => unknown },
        ctx.userId,
        everyRowId,
      );

      const items = pageRows.map((row) => {
        const kids = repliesByParent[row.id] ?? [];
        return {
          ...toCommentOut(row, ctx.userId, likedSet),
          replyCount: Math.max(row.reply_count ?? 0, kids.length),
          replies: kids.map((k) => toCommentOut(k, ctx.userId, likedSet)),
        };
      });

      const nextCursor = hasMore
        ? cursorFromRow(pageRows[pageRows.length - 1] as CommentRow)
        : null;
      return { items, nextCursor };
    }),

  // Full replies list for one top-level comment. Chronological.
  listReplies: protectedProcedure
    .use(queryLimit('comments.listReplies', { perMin: 60 }))
    .input(
      z.object({
        commentId: z.string().uuid(),
        cursor: z
          .string()
          .datetime()
          .optional()
          .refine((v) => v === undefined || Date.parse(v) <= Date.now(), {
            message: 'cursor must not be in the future',
          }),
      }),
    )
    .query(async ({ ctx, input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (ctx.db as any)
        .from('comments')
        .select(
          'id, topic_id, parent_id, user_id, handle, stance, body, deleted_at, like_count, created_at',
        )
        .eq('parent_id', input.commentId)
        .order('created_at', { ascending: true })
        .limit(REPLY_PAGE_SIZE + 1);
      if (input.cursor) q = q.gt('created_at', input.cursor);
      const { data, error } = (await q) as {
        data: CommentRow[] | null;
        error: { code?: string; message: string } | null;
      };
      if (error) {
        console.warn(
          JSON.stringify({ event: 'comments.list_replies_failed', code: error.code ?? 'unknown' }),
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load replies.',
          cause: new Error(error.code ?? 'db_error'),
        });
      }
      const rows = data ?? [];
      const hasMore = rows.length > REPLY_PAGE_SIZE;
      const pageRows = hasMore ? rows.slice(0, REPLY_PAGE_SIZE) : rows;
      const likedSet = await fetchLikedSet(
        ctx.db as unknown as { from: (t: string) => unknown },
        ctx.userId,
        pageRows.map((r) => r.id),
      );
      const items = pageRows.map((row) => toCommentOut(row, ctx.userId, likedSet));
      const nextCursor = hasMore
        ? cursorFromRow(pageRows[pageRows.length - 1] as CommentRow)
        : null;
      return { items, nextCursor };
    }),

  // Write: delegates to public.create_comment.
  create: protectedProcedure
    .use(mutationLimit('comments.create', { perMin: 5 }))
    .input(
      z.object({
        topicId: z.string().uuid(),
        // Nullable → top-level comment. When present, the SQL enforces
        // parent ∈ same topic AND parent is top-level.
        parentId: z.string().uuid().nullable().optional(),
        // Trim on both sides at the edge. SQL re-checks after its own
        // btrim, so an empty-after-trim body raises 22023.
        body: z.string().trim().min(1, 'Say something.').max(BODY_MAX),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = (await (ctx.db as any).rpc('create_comment', {
        p_topic_id: input.topicId,
        p_parent_id: input.parentId ?? null,
        p_body: input.body,
      })) as {
        data: CommentRow | null;
        error: { code?: string; message?: string } | null;
      };
      if (error) {
        const code = error.code;
        const msg = error.message ?? '';
        // Map the SQL SQLSTATE contract from migration 20261126000000.
        if (code === '28000') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
        }
        if (code === '22023') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Body must be 1 to 500 characters.',
            cause: new Error(code),
          });
        }
        if (code === '54000') {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many comments in the last 24 hours.',
            cause: new Error('rate_limited'),
          });
        }
        if (code === 'P0002') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Topic not found.' });
        }
        if (code === 'P0001') {
          if (msg.includes('no_locked_stance')) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Lock in a stance on this topic to comment.',
              cause: new Error('no_locked_stance'),
            });
          }
          if (msg.includes('parent_not_found')) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Parent comment not found.' });
          }
          if (msg.includes('reply_depth_exceeded')) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Replies only go one level deep.',
              cause: new Error('reply_depth_exceeded'),
            });
          }
          if (msg.includes('parent_topic_mismatch')) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Parent comment is on a different topic.',
              cause: new Error('parent_topic_mismatch'),
            });
          }
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save comment.',
          cause: new Error(code ?? 'db_error'),
        });
      }
      if (!data) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save comment.',
          cause: new Error('rpc_null_result'),
        });
      }
      return toCommentOut(data, ctx.userId, new Set());
    }),

  // Soft delete by author. Replies stay.
  delete: protectedProcedure
    .use(mutationLimit('comments.delete', { perMin: 10 }))
    .input(z.object({ commentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = (await (ctx.db as any).rpc('delete_own_comment', {
        p_comment_id: input.commentId,
      })) as {
        data: CommentRow | null;
        error: { code?: string; message?: string } | null;
      };
      if (error) {
        const code = error.code;
        const msg = error.message ?? '';
        if (code === '28000') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
        }
        if (code === 'P0002') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Comment not found.' });
        }
        if (code === 'P0001' && msg.includes('not_owner')) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the author can delete this comment.',
            cause: new Error('not_owner'),
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete comment.',
          cause: new Error(code ?? 'db_error'),
        });
      }
      if (!data) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete comment.',
          cause: new Error('rpc_null_result'),
        });
      }
      return toCommentOut(data, ctx.userId, new Set());
    }),

  // Toggle like. Returns { liked, likeCount } so the client can
  // optimistically reconcile.
  toggleLike: protectedProcedure
    .use(mutationLimit('comments.toggleLike', { perMin: 60 }))
    .input(z.object({ commentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = (await (ctx.db as any).rpc('toggle_comment_like', {
        p_comment_id: input.commentId,
      })) as {
        data:
          | Array<{ liked: boolean; like_count: number }>
          | { liked: boolean; like_count: number }
          | null;
        error: { code?: string; message?: string } | null;
      };
      if (error) {
        const code = error.code;
        if (code === '28000') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
        }
        if (code === 'P0002') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Comment not found.' });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to toggle like.',
          cause: new Error(code ?? 'db_error'),
        });
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to toggle like.',
          cause: new Error('rpc_null_result'),
        });
      }
      return { liked: row.liked, likeCount: row.like_count };
    }),
});
