// Battles router. Three procedures drive the live trivia battle UI:
//
//   - getBattle    full battle snapshot (status, participants, all rounds)
//   - getRound     latest round_no > sinceRoundNo (the 1-second polling
//                  endpoint the web client hits while a battle is live)
//   - submitAnswer service-role write into trivia_answers; client-supplied
//                  chosenIndex is graded against the question's
//                  correct_index inside the procedure so a lying client
//                  can't fake a correct answer.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';
import { serviceRoleClient } from '../supabase.js';

const battleIdInput = z.object({ battleId: z.string().uuid() });

export const battlesRouter = router({
  getBattle: protectedProcedure.input(battleIdInput).query(async ({ ctx, input }) => {
    const [battleRes, participantsRes, roundsRes] = await Promise.all([
      ctx.db
        .from('battles')
        .select('id, mode, status, winner_user_id, ap_pot, started_at, ended_at')
        .eq('id', input.battleId)
        .maybeSingle(),
      ctx.db
        .from('battle_participants')
        .select('user_id, seat, entry_ap, result, joined_at')
        .eq('battle_id', input.battleId)
        .order('seat', { ascending: true }),
      ctx.db
        .from('battle_rounds')
        .select('id, round_no, payload, winner_user_id, created_at')
        .eq('battle_id', input.battleId)
        .order('round_no', { ascending: true }),
    ]);

    if (battleRes.error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load battle.',
        cause: battleRes.error,
      });
    }
    if (!battleRes.data) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Battle not found.' });
    }
    if (participantsRes.error || roundsRes.error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load battle children.',
        cause: participantsRes.error ?? roundsRes.error,
      });
    }

    const battle = battleRes.data;
    return {
      id: battle.id,
      mode: battle.mode,
      status: battle.status,
      winnerUserId: battle.winner_user_id,
      apPot: battle.ap_pot,
      startedAt: battle.started_at,
      endedAt: battle.ended_at,
      participants: (participantsRes.data ?? []).map((p) => ({
        userId: p.user_id,
        seat: p.seat,
        entryAp: p.entry_ap,
        result: p.result,
        joinedAt: p.joined_at,
      })),
      rounds: (roundsRes.data ?? []).map((r) => ({
        id: r.id,
        roundNo: r.round_no,
        payload: r.payload,
        winnerUserId: r.winner_user_id,
        createdAt: r.created_at,
      })),
    };
  }),

  getRound: protectedProcedure
    .input(
      battleIdInput.extend({
        sinceRoundNo: z.number().int().min(-1).default(-1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from('battle_rounds')
        .select('id, round_no, payload, winner_user_id, created_at')
        .eq('battle_id', input.battleId)
        .gt('round_no', input.sinceRoundNo)
        .order('round_no', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load round.',
          cause: error,
        });
      }
      if (!data) return { round: null };
      return {
        round: {
          id: data.id,
          roundNo: data.round_no,
          payload: data.payload,
          winnerUserId: data.winner_user_id,
          createdAt: data.created_at,
        },
      };
    }),

  submitAnswer: protectedProcedure
    .input(
      battleIdInput.extend({
        roundId: z.string().uuid(),
        chosenIndex: z.number().int().min(0).max(3),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Confirm the battle is live and the caller is a participant
      //    (RLS gates this via battle_participants.user_id = auth.uid()).
      const { data: battle, error: battleErr } = await ctx.db
        .from('battles')
        .select('id, status')
        .eq('id', input.battleId)
        .maybeSingle();
      if (battleErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read battle.',
          cause: battleErr,
        });
      }
      if (!battle) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Battle not found.' });
      }
      if (battle.status !== 'live') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Battle is not accepting answers.',
        });
      }

      // 2. Look up the round + the embedded question id.
      const { data: round, error: roundErr } = await ctx.db
        .from('battle_rounds')
        .select('id, round_no, payload, created_at')
        .eq('id', input.roundId)
        .eq('battle_id', input.battleId)
        .maybeSingle<{
          id: string;
          round_no: number;
          payload: { questionId?: string };
          created_at: string;
        }>();
      if (roundErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read round.',
          cause: roundErr,
        });
      }
      if (!round) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Round not found.' });
      }
      const questionId = round.payload.questionId;
      if (!questionId) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Round payload missing questionId.',
        });
      }

      // 3. Read the correct_index. trivia_questions RLS only exposes
      //    verified=true rows; battle questions must already be verified.
      const { data: question, error: qErr } = await ctx.db
        .from('trivia_questions')
        .select('correct_index')
        .eq('id', questionId)
        .maybeSingle<{ correct_index: number }>();
      if (qErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read question.',
          cause: qErr,
        });
      }
      if (!question) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Question not found.' });
      }

      const latencyMs = Math.max(0, Date.now() - new Date(round.created_at).getTime());
      const correct = input.chosenIndex === question.correct_index;

      // 4. Service-role insert. The table's RLS policy only grants SELECT
      //    to authenticated callers; INSERT is service-role-only by
      //    design (migration 0004) so the game server holds the truth.
      const service = serviceRoleClient(ctx.env);
      const { error: insertErr } = await service.from('trivia_answers').insert({
        battle_id: input.battleId,
        round_id: input.roundId,
        user_id: ctx.userId,
        question_id: questionId,
        chosen_index: input.chosenIndex,
        correct,
        latency_ms: latencyMs,
      });
      if (insertErr) {
        // 23505 = duplicate (battle_id, round_id, user_id) if we ever
        // add such a unique. Today the table has no such constraint
        // but we map for forward compat.
        if ((insertErr as { code?: string }).code === '23505') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Already answered this round.',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record answer.',
          cause: insertErr,
        });
      }

      return { correct, latencyMs };
    }),
});
