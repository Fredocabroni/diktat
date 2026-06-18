// Matchmaking router. Path B / no-BullMQ — the queue is an Upstash
// sorted set (`mm:trivia:queue`). The router writes to it; an in-
// process loop in apps/workers (`runMatchmakingTick`) pairs entries
// and creates battle rows. Status reads return `waiting`, `matched`,
// or `idle` with the battle id when matched.
//
// Practice-match disclosure (per ADDICTION_ARCHITECTURE.md §11
// "shadow bans without notification"): when the workers tick falls
// back to a bot opponent, it sets `opponentIsBot=true` in the matched
// record. The client renders the "Practice match — bot opponent"
// badge from this signal — never silently passes it off as a human.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';

const modeSchema = z.enum(['trivia', 'open_debate']);
type Mode = z.infer<typeof modeSchema>;
const META_TTL_S = 600;

function queueKey(mode: Mode): string {
  return `mm:${mode}:queue`;
}
function metaKey(mode: Mode, userId: string): string {
  return `mm:${mode}:meta:${userId}`;
}
function matchedKey(mode: Mode, userId: string): string {
  return `mm:${mode}:matched:${userId}`;
}

interface QueueMeta {
  ap: number;
  joinedAtMs: number;
  mode: Mode;
  /** Required when mode='open_debate'. Seeker's topic wins on match. */
  topicId?: string;
}

interface MatchedRecord {
  battleId: string;
  role: 'human' | 'practice';
  opponentIsBot: boolean;
}

function parseJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const matchmakingRouter = router({
  enqueue: protectedProcedure
    .input(
      z
        .object({
          mode: modeSchema,
          /** Required for mode='open_debate': the news_topic to debate. */
          topicId: z.string().uuid().optional(),
        })
        .refine((v) => v.mode !== 'open_debate' || Boolean(v.topicId), {
          message: 'topicId is required for open_debate',
          path: ['topicId'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      // Read the user's current AP — score for the sorted set.
      const { data: userRow, error } = await ctx.db
        .from('users')
        .select('current_ap, is_bot')
        .eq('id', ctx.userId)
        .maybeSingle<{ current_ap: number; is_bot: boolean }>();

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read user AP.',
          cause: error,
        });
      }
      if (!userRow) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
      }
      if (userRow.is_bot) {
        // Bots never enqueue; defense in depth — a normal signup path
        // can't produce a bot session, but better explicit than silent.
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Bots cannot enqueue.' });
      }

      const ap = userRow.current_ap;
      const joinedAtMs = Date.now();
      const mode: Mode = input.mode;

      const meta: QueueMeta = {
        ap,
        joinedAtMs,
        mode,
        ...(input.topicId ? { topicId: input.topicId } : {}),
      };
      await ctx.redis.zadd(queueKey(mode), { score: ap, member: ctx.userId! });
      await ctx.redis.set(metaKey(mode, ctx.userId!), JSON.stringify(meta), {
        ex: META_TTL_S,
      });

      // Best-effort activity bump via SECURITY DEFINER
      // `bump_last_active()` (migration 20260618170000). The function
      // stamps server-side now() (caller cannot backdate or replay
      // an arbitrary moment) and is locked to auth.uid(). Fire-and-
      // forget: matchmaking already succeeded; an activity-tracking
      // failure must not roll it back. PR #44 round-2 security-
      // reviewer MEDIUM-4: log on error so a systemic failure
      // (function dropped, permission revoked) is visible in
      // production instead of silently stagnating last_active_at.
      void Promise.resolve(ctx.db.rpc('bump_last_active'))
        .then(({ error }) => {
          if (error) {
            console.warn({
              event: 'bump_last_active.failed',
              code: error.code,
              message: error.message,
            });
          }
        })
        .catch((e: unknown) => {
          console.warn({
            event: 'bump_last_active.failed',
            error: e instanceof Error ? e.message : String(e),
          });
        });

      return { status: 'waiting' as const, joinedAtMs, ap, mode };
    }),

  cancel: protectedProcedure
    .input(z.object({ mode: modeSchema }))
    .mutation(async ({ ctx, input }) => {
      const removed = await ctx.redis.zrem(queueKey(input.mode), ctx.userId!);
      await ctx.redis.del(metaKey(input.mode, ctx.userId!));
      return { ok: true, wasQueued: removed > 0 };
    }),

  getStatus: protectedProcedure
    .input(z.object({ mode: modeSchema }))
    .query(async ({ ctx, input }) => {
      const matchedRaw = await ctx.redis.get(matchedKey(input.mode, ctx.userId!));
      if (matchedRaw !== null && matchedRaw !== undefined) {
        const matched = parseJson<MatchedRecord>(matchedRaw);
        if (matched) {
          return {
            status: 'matched' as const,
            battleId: matched.battleId,
            opponentIsBot: matched.opponentIsBot,
          };
        }
      }
      const score = await ctx.redis.zscore(queueKey(input.mode), ctx.userId!);
      if (score !== null && score !== undefined) {
        const metaRaw = await ctx.redis.get(metaKey(input.mode, ctx.userId!));
        const meta = parseJson<QueueMeta>(metaRaw);
        return {
          status: 'waiting' as const,
          ...(meta ? { joinedAtMs: meta.joinedAtMs, ap: meta.ap } : {}),
        };
      }
      return { status: 'idle' as const };
    }),
});
