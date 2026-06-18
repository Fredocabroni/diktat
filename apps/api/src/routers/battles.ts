// Battles router. Three procedures drive the live trivia battle UI:
//
//   - getBattle    full battle snapshot (status, participants, all rounds)
//   - getRound     latest round_no > sinceRoundNo (the 1-second polling
//                  endpoint the web client hits while a battle is live)
//   - submitAnswer routes through SECURITY DEFINER `submit_trivia_answer`
//                  (migration 20260618180000). The function grades the
//                  chosenIndex server-side against trivia_questions.
//                  correct_index — a column the user-scoped client can
//                  NEVER read directly (column-grant restricted). The
//                  UNIQUE (round_id, user_id) constraint on
//                  trivia_answers enforces one-shot semantics — the
//                  function raises 23505 on re-submission.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';

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
      // All four checks (battle live, caller-is-participant,
      // round-belongs-to-battle, question exists) + the
      // correct_index read + the trivia_answers insert happen
      // inside `submit_trivia_answer` (migration 20260618180000).
      // The function returns `setof (correct, latency_ms)` —
      // chain `.maybeSingle()` to narrow to row | null.
      const { data, error } = await ctx.db
        .rpc('submit_trivia_answer', {
          p_battle_id: input.battleId,
          p_round_id: input.roundId,
          p_chosen_index: input.chosenIndex,
        })
        .maybeSingle();

      if (error) {
        // Map Postgres sqlstate → tRPC error code. The function
        // raises:
        //   28000  unauthenticated         → UNAUTHORIZED
        //   42501  not a participant       → FORBIDDEN
        //   22023  bad input / not live    → BAD_REQUEST
        //   P0002  battle/round/question missing → NOT_FOUND
        //   23505  already answered        → CONFLICT
        const code = (error as { code?: string }).code;
        const map: Record<
          string,
          'UNAUTHORIZED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT'
        > = {
          '28000': 'UNAUTHORIZED',
          '42501': 'FORBIDDEN',
          '22023': 'BAD_REQUEST',
          P0002: 'NOT_FOUND',
          '23505': 'CONFLICT',
        };
        throw new TRPCError({
          code: map[code ?? ''] ?? 'INTERNAL_SERVER_ERROR',
          message: error.message,
          cause: error,
        });
      }
      if (!data) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'submit_trivia_answer returned no row.',
        });
      }

      return { correct: data.correct, latencyMs: data.latency_ms };
    }),
});
