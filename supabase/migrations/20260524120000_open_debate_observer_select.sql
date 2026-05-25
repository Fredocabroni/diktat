-- Migration: open_debate observer SELECT on battles + battle_participants
-- Up:   Additive RLS policies so a non-participant authenticated user can
--       read the battle row + the seat metadata for any open_debate battle
--       whose status is 'live' or 'settled'. Mirrors the additive observer
--       policy that PR #26 already added on battle_rounds
--       (battle_rounds_select_open_debate_observers). Required for the
--       open-debate vote panel UI (PR 4.6 commit 4) — non-participants
--       need to see the participants to vote for one of them.
-- Down: drop policy battles_select_open_debate_observers;
--       drop policy battle_participants_select_open_debate_observers;
--
-- Why additive (not a replacement):
--   * battles already has participants-only + queued-discovery policies
--     (migration 0004). This policy is OR-ed with those — existing
--     participants continue to see their own battles regardless of mode.
--   * battle_participants already has a self-only SELECT policy
--     (bp_select_self). Same OR-semantics for observers.
--   * Both new policies are scoped to mode='open_debate' so trivia rows
--     keep their participants-only privacy.
--   * Authenticated-only — anon users get nothing new. Open debate
--     observation is a logged-in-user surface; spectators must be in
--     the system.
--
-- Privacy boundary:
--   * Observers can read battle metadata (id, mode, status, topic_id,
--     winner_user_id) + the participants' user_ids + seats + entry_ap.
--   * Argument text is gated separately by debate_arguments RLS
--     (debate_args_select_revealed) which already lets observers read
--     revealed-round arguments — no change needed there.
--   * Vote rows are gated separately by debate_votes RLS — observers
--     see their own vote during the window, all votes post-settlement
--     (debate_votes_select_settled). No change needed.

begin;

create policy battles_select_open_debate_observers on public.battles
  for select to authenticated
  using (mode = 'open_debate' and status in ('live', 'settled'));

create policy battle_participants_select_open_debate_observers on public.battle_participants
  for select to authenticated
  using (
    exists (
      select 1 from public.battles b
      where b.id = battle_participants.battle_id
        and b.mode = 'open_debate'
        and b.status in ('live', 'settled')
    )
  );

commit;
