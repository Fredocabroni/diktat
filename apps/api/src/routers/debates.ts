// Open Debate tRPC router. PR 4.5 backend.
//
// Endpoints:
//   getBattle({ battleId })     -- battle + rounds + arguments (RLS-gated)
//   submitArgument({ ... })     -- per-seat blind submission per round
//   castVote({ battleId, ... }) -- one community AP-weighted vote per debate
//
// Lifecycle (matchmaking + runner already own these):
//   - Enqueue with mode='open_debate' + topicId via the matchmaking router.
//   - When matched, the workers matchmaker creates a battle row with
//     topic_id; the workers open-debate-runner walks the rounds.
//   - This router serves only the user-facing API surface that drives the
//     UI's compose / vote actions. State transitions are runner-owned.
//
// Validation enforces what RLS cannot:
//   - submitArgument: caller must be a battle participant, round must be in
//     `awaiting_arguments` state, deadline_at must not have passed, caller
//     must not have already submitted. Text length is enforced both by Zod
//     and by the column CHECK constraint.
//   - castVote: caller must NOT be a battle participant, verdict round must
//     be in `awaiting_final_vote`, vote deadline must not have passed, caller
//     must not have already voted. Voter's current_ap is snapshotted into
//     ap_at_vote_time for AP-weighted tally.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { mutationLimit, queryLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';

const VERDICT_ROUND_NO = 3;
const ARGUMENT_MIN = 100;
const ARGUMENT_MAX = 2000;

const argumentSchema = z.string().min(ARGUMENT_MIN).max(ARGUMENT_MAX);

interface RoundShape {
  id: string;
  round_no: number;
  payload: Record<string, unknown> | null;
  deadline_at: string | null;
}

export const debatesRouter = router({
  /**
   * Full debate state for the UI's poll. Returns the battle, participants,
   * rounds (with payload state + deadline), and arguments visible to the
   * caller (RLS enforces blind submission -- the opponent's argument is
   * filtered out by the database until the round reveals).
   *
   * Privacy boundary — RLS is authoritative; this resolver does NOT gate.
   * Documented here so a future reader doesn't have to chase the policy
   * chain across migrations. Mirrors the explicit contract in
   * `supabase/migrations/20260524120000_open_debate_observer_select.sql`
   * (PR 4.6 commit 4). PR #62 round-2 LOW-2 disclosure pass.
   *
   *   participants (battle_participants)
   *     - PARTICIPANT view: own row only, via `bp_select_self`
   *       (migration 20260420090004) → `USING (is_self(user_id))`.
   *     - OBSERVER view: ANY authenticated user can read all seat rows
   *       when `battle.mode='open_debate' AND battle.status IN
   *       ('live','settled')`, via
   *       `battle_participants_select_open_debate_observers` (additive,
   *       migration 20260524120000). Intentional — the open-debate
   *       VotePanel UI needs to render handles to label seats for
   *       community vote casting.
   *     - All other modes (trivia) + non-(live|settled) statuses:
   *       non-participants get empty `participants[]`.
   *
   *   fields observer-visible: user_id, seat, entry_ap, result, and
   *     `users(handle)` via PostgREST inline-join. Handle is in the
   *     public column subset (`users_access_column_grants`,
   *     migration 20260618120000) by §1 product spec — handles render
   *     on leaderboards, profile pages, and tier badges. Not specific
   *     to this surface.
   *
   *   arguments (debate_arguments): gated separately by
   *     `debate_args_select_revealed` — observers see only round-
   *     revealed text, never blind-submission text.
   *   votes (debate_votes): gated separately — own vote during the
   *     live window via `debate_votes_select_own`, all votes
   *     post-settlement via `debate_votes_select_settled`.
   *   battles row: gated by `battles_select_participants` +
   *     `battles_select_queued` + `battles_select_open_debate_observers`
   *     (OR-ed); observer admission is again gated to
   *     `mode='open_debate' AND status IN ('live','settled')`.
   *
   * NO resolver-level mode/status branch. Shadowing the RLS rule here
   * would create two contradictory truth-sources for the privacy
   * boundary; if RLS regresses (column dropped from policy USING
   * clause, observer policy widened, handle moved to the private
   * column subset), the resolver must reflect that immediately and
   * mechanically — not be a stale second copy.
   */
  getBattle: protectedProcedure
    // M5.1 — 90/min per user. Polled at 0.5Hz (30/min baseline) with
    // refetchIntervalInBackground=false; 3x headroom for reconnects.
    // THE LOAD-BEARING CAP: 5-query fan-out per call. At 90/min the
    // worst-case DB load is 450 sub-queries/min/user (vs 150/min at
    // the 30/min client baseline). Round-3 reviewer's specific concern.
    .use(queryLimit('debates.getBattle', { perMin: 90 }))
    .input(z.object({ battleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [battleResult, participantsResult, roundsResult, argsResult, votesResult] =
        await Promise.all([
          ctx.db
            .from('battles')
            .select('id, mode, status, topic_id, started_at, ended_at, ap_pot, winner_user_id')
            .eq('id', input.battleId)
            .maybeSingle(),
          ctx.db
            .from('battle_participants')
            .select('user_id, seat, entry_ap, result, users(handle)')
            .eq('battle_id', input.battleId),
          ctx.db
            .from('battle_rounds')
            .select('id, round_no, payload, deadline_at, winner_user_id')
            .eq('battle_id', input.battleId)
            .order('round_no'),
          ctx.db
            .from('debate_arguments')
            .select('round_id, user_id, text, submitted_at')
            .eq('battle_id', input.battleId),
          // RLS filters this to the caller's own vote during the live window
          // (debate_votes_select_own); after settlement everyone sees all
          // votes (debate_votes_select_settled). The verdict round's
          // payload.community holds the canonical aggregate post-settle, so
          // this surface is just used by the live vote-panel UI to detect
          // "you already voted" after a refresh.
          ctx.db
            .from('debate_votes')
            .select('voter_user_id, vote_for_user_id, ap_at_vote_time, voted_at')
            .eq('battle_id', input.battleId),
        ]);

      if (battleResult.error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read battle.',
          cause: battleResult.error,
        });
      }
      if (!battleResult.data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Battle not found.' });
      }
      if (battleResult.data.mode !== 'open_debate') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Battle is not an open debate.',
        });
      }

      return {
        battle: battleResult.data,
        participants: participantsResult.data ?? [],
        rounds: roundsResult.data ?? [],
        arguments: argsResult.data ?? [],
        votes: votesResult.data ?? [],
      };
    }),

  /**
   * Submit your argument for the current round. Blind -- the opponent
   * cannot see it (RLS) until the round transitions to 'revealed' (both
   * submitted, or deadline passed).
   */
  submitArgument: protectedProcedure
    // M5 — 10/min per user. 100-2000 char text; humans type slow.
    .use(mutationLimit('debates.submitArgument', { perMin: 10 }))
    .input(
      z.object({
        roundId: z.string().uuid(),
        text: argumentSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Round must exist, be in awaiting_arguments, and not past deadline.
      const { data: round, error: roundErr } = await ctx.db
        .from('battle_rounds')
        .select('id, battle_id, round_no, payload, deadline_at')
        .eq('id', input.roundId)
        .maybeSingle<RoundShape & { battle_id: string }>();
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
      if (round.round_no >= VERDICT_ROUND_NO) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot submit on verdict round.' });
      }
      const state = roundState(round.payload);
      if (state !== 'awaiting_arguments') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Round is not accepting arguments (state=${state}).`,
        });
      }
      if (round.deadline_at && new Date(round.deadline_at).getTime() <= Date.now()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Round deadline has passed.' });
      }

      // 2. Caller must be a participant.
      const { data: participation, error: pErr } = await ctx.db
        .from('battle_participants')
        .select('user_id, seat')
        .eq('battle_id', round.battle_id)
        .eq('user_id', ctx.userId!)
        .maybeSingle();
      if (pErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to verify participation.',
          cause: pErr,
        });
      }
      if (!participation) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only debate participants can submit arguments.',
        });
      }

      // 3. Insert. The unique (round_id, user_id) index makes a second
      //    submission from the same seat fail at the DB layer (23505).
      const { data, error } = await ctx.db
        .from('debate_arguments')
        .insert({
          battle_id: round.battle_id,
          round_id: round.id,
          user_id: ctx.userId!,
          text: input.text,
        })
        .select('id, submitted_at')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'You already submitted an argument this round.',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save argument.',
          cause: error,
        });
      }
      return { ok: true, argumentId: data?.id, submittedAt: data?.submitted_at };
    }),

  /**
   * Cast a community vote on a debate's outcome. One vote per non-participant
   * per debate. Voter's current_ap is snapshotted -- the verdict round will
   * tally by sum(ap_at_vote_time), so Vanguard+ voters weigh more (§6.4
   * Cialdini authority).
   */
  castVote: protectedProcedure
    // M5 round-2 — 20/min per user. Verdict-round opens to all
    // non-participants simultaneously; the budget is loose enough
    // not to pinch normal voting while still capping the
    // unconstrained 3-DB-round-trip load surface the round-1
    // security-reviewer flagged.
    .use(mutationLimit('debates.castVote', { perMin: 20 }))
    .input(
      z.object({
        battleId: z.string().uuid(),
        voteForUserId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Verdict round must be in awaiting_final_vote and within window.
      const { data: verdictRound, error: vrErr } = await ctx.db
        .from('battle_rounds')
        .select('id, payload, deadline_at')
        .eq('battle_id', input.battleId)
        .eq('round_no', VERDICT_ROUND_NO)
        .maybeSingle<RoundShape>();
      if (vrErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read verdict round.',
          cause: vrErr,
        });
      }
      if (!verdictRound) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Voting is not yet open for this debate.',
        });
      }
      if (roundState(verdictRound.payload) !== 'awaiting_final_vote') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Voting window is closed.' });
      }
      if (verdictRound.deadline_at && new Date(verdictRound.deadline_at).getTime() <= Date.now()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Voting window has expired.' });
      }

      // 2. Voter must NOT be a participant; vote_for_user_id MUST be one.
      const { data: parts, error: pErr } = await ctx.db
        .from('battle_participants')
        .select('user_id')
        .eq('battle_id', input.battleId);
      if (pErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read participants.',
          cause: pErr,
        });
      }
      const participantIds = new Set((parts ?? []).map((p) => p.user_id));
      if (participantIds.has(ctx.userId!)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Participants cannot vote on their own debate.',
        });
      }
      if (!participantIds.has(input.voteForUserId)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'vote_for_user_id is not a participant in this debate.',
        });
      }

      // 3. Snapshot voter's AP and insert. Unique (battle_id, voter_user_id)
      //    blocks duplicate votes at the DB.
      const { data: voterRow, error: uErr } = await ctx.db
        .from('users')
        .select('current_ap')
        .eq('id', ctx.userId!)
        .maybeSingle<{ current_ap: number }>();
      if (uErr || !voterRow) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read voter AP.',
          cause: uErr,
        });
      }

      const { data, error } = await ctx.db
        .from('debate_votes')
        .insert({
          battle_id: input.battleId,
          voter_user_id: ctx.userId!,
          vote_for_user_id: input.voteForUserId,
          ap_at_vote_time: voterRow.current_ap,
        })
        .select('id')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'You have already voted on this debate.',
          });
        }
        // DK001 / DK002 are the DB-layer TOCTOU backstop for the two
        // participant invariants checked resolver-side in step 2 — the
        // BEFORE INSERT trigger on debate_votes (migration
        // 20260622141706) fires the same predicates atomically with the
        // insert. Wire messages stay byte-identical to step 2's so a
        // race that the resolver narrowly missed is reported as the
        // same user-facing error rather than a generic 500.
        if (error.code === 'DK001') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Participants cannot vote on their own debate.',
          });
        }
        if (error.code === 'DK002') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'vote_for_user_id is not a participant in this debate.',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save vote.',
          cause: error,
        });
      }
      // `voterRow.current_ap` is the authoritative AP snapshot and is
      // written to `ap_at_vote_time` above; do NOT echo it back on the
      // wire. Returning the caller's authoritative AP turned every vote
      // into an oracle a stale client could use to refresh its cached
      // balance from the server. The visible "weight" chip in
      // VotePanel.tsx reads `ap_at_vote_time` off the votes list
      // returned by `debates.getBattle`, not off this mutation's
      // response — no UI consumer reads `apWeight`. PR #62 round-3
      // MEDIUM-2 disclosure pass.
      return { ok: true, voteId: data?.id };
    }),
});

function roundState(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  const state = (payload as { state?: unknown }).state;
  return typeof state === 'string' ? state : '';
}
