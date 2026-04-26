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

const TRIVIA = 'trivia' as const;
const META_TTL_S = 600;

function queueKey(): string {
  return `mm:${TRIVIA}:queue`;
}
function metaKey(userId: string): string {
  return `mm:${TRIVIA}:meta:${userId}`;
}
function matchedKey(userId: string): string {
  return `mm:${TRIVIA}:matched:${userId}`;
}

interface QueueMeta {
  ap: number;
  joinedAtMs: number;
  mode: typeof TRIVIA;
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
    .input(z.object({ mode: z.literal('trivia') }))
    .mutation(async ({ ctx }) => {
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

      const meta: QueueMeta = { ap, joinedAtMs, mode: TRIVIA };
      await ctx.redis.zadd(queueKey(), { score: ap, member: ctx.userId! });
      await ctx.redis.set(metaKey(ctx.userId!), JSON.stringify(meta), {
        ex: META_TTL_S,
      });

      // Best-effort activity bump. The column may not exist in
      // generated types yet (migration 0010 lands with PR #15) — the
      // untyped cast keeps this forward-compatible.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.db as any)
        .from('users')
        .update({ last_active_at: new Date(joinedAtMs).toISOString() })
        .eq('id', ctx.userId);

      return { status: 'waiting' as const, joinedAtMs, ap };
    }),

  cancel: protectedProcedure
    .input(z.object({ mode: z.literal('trivia') }))
    .mutation(async ({ ctx }) => {
      const removed = await ctx.redis.zrem(queueKey(), ctx.userId!);
      await ctx.redis.del(metaKey(ctx.userId!));
      return { ok: true, wasQueued: removed > 0 };
    }),

  getStatus: protectedProcedure
    .input(z.object({ mode: z.literal('trivia') }))
    .query(async ({ ctx }) => {
      const matchedRaw = await ctx.redis.get(matchedKey(ctx.userId!));
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
      const score = await ctx.redis.zscore(queueKey(), ctx.userId!);
      if (score !== null && score !== undefined) {
        const metaRaw = await ctx.redis.get(metaKey(ctx.userId!));
        const meta = parseJson<QueueMeta>(metaRaw);
        return {
          status: 'waiting' as const,
          ...(meta ? { joinedAtMs: meta.joinedAtMs, ap: meta.ap } : {}),
        };
      }
      return { status: 'idle' as const };
    }),
});
