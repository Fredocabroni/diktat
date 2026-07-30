-- Security fix (#114): route debate votes through a SECURITY DEFINER RPC so that
-- ap_at_vote_time -- the DECISIVE AP-weighted community-vote tally weight -- is
-- snapshotted from users.current_ap server-side and cannot be forged.
--
-- The dropped `debate_votes_insert_self` policy let any authenticated user INSERT
-- a vote directly via PostgREST with a client-controlled ap_at_vote_time. The
-- BEFORE INSERT participation trigger (DK001/DK002, migration 20260622141706) and
-- the unique(battle_id, voter_user_id) constraint were the only DB-layer guards;
-- ap_at_vote_time, the votable-round state, and the deadline were enforced only in
-- the castVote tRPC and thus bypassable. Exploit isn't tallied until the
-- open-debate runner (apps/workers) deploys -- so this lands BEFORE that (#111).
--
-- Same pattern as H3 (place_prediction, 20260729120000): move a client-controlled
-- *_insert_self write behind an RPC that enforces the coupled invariant atomically.

begin;

-- (a) Drop the direct client insert path -- the RPC below becomes the only writer.
--     Select policies (own vote / settled) and the DK001/DK002 participation
--     trigger are unaffected.
drop policy if exists debate_votes_insert_self on public.debate_votes;

-- (b) The vote RPC. Voter = auth.uid() (never client-supplied). ap_at_vote_time is
--     read from users.current_ap server-side. The votable round is derived from
--     the payload STATE (the synthetic verdict round is the only one that enters
--     'awaiting_final_vote') -- no hardcoded round_no.
create or replace function public.cast_debate_vote(
  p_battle_id        uuid,
  p_vote_for_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voter    uuid;
  v_round_id uuid;
  v_deadline timestamptz;
  v_ap       integer;
  v_vote_id  uuid;
begin
  -- (1) Auth. EXECUTE is granted to authenticated only + PUBLIC revoked; the
  --     inline guard is defence-in-depth.
  v_voter := auth.uid();
  if v_voter is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_vote_for_user_id is null then
    raise exception 'vote_for_user_id required' using errcode = '22023';
  end if;

  -- (2) Open votable round, derived from payload state (NOT a hardcoded round_no).
  --     Only the verdict round enters 'awaiting_final_vote'. Must exist + be within
  --     the deadline.
  select r.id, r.deadline_at
    into v_round_id, v_deadline
    from public.battle_rounds r
    where r.battle_id = p_battle_id
      and r.payload->>'state' = 'awaiting_final_vote'
    limit 1;
  if v_round_id is null then
    raise exception 'voting is not open for this debate' using errcode = 'DK003';
  end if;
  if v_deadline is not null and v_deadline <= now() then
    raise exception 'voting window has expired' using errcode = 'DK004';
  end if;

  -- (3) Participation -- redundant with the DK001/DK002 BEFORE INSERT trigger, but
  --     enforced here for clean, specific errors. Voter must NOT be a participant;
  --     the target MUST be.
  if exists (
    select 1 from public.battle_participants p
    where p.battle_id = p_battle_id and p.user_id = v_voter
  ) then
    raise exception 'participants cannot vote on their own debate' using errcode = 'DK001';
  end if;
  if not exists (
    select 1 from public.battle_participants p
    where p.battle_id = p_battle_id and p.user_id = p_vote_for_user_id
  ) then
    raise exception 'vote_for_user_id is not a participant in this debate' using errcode = 'DK002';
  end if;

  -- (4) Server-read AP snapshot -- the whole point of #114. This value, never a
  --     client input, is the tally weight.
  select current_ap into v_ap from public.users where id = v_voter;
  if v_ap is null then
    raise exception 'voter not found' using errcode = 'P0002';
  end if;

  -- (5) Insert. unique (battle_id, voter_user_id) blocks a double vote.
  begin
    insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
    values (p_battle_id, v_voter, p_vote_for_user_id, v_ap)
    returning id into v_vote_id;
  exception when unique_violation then
    raise exception 'already voted on this debate' using errcode = '23505';
  end;

  return v_vote_id;
end;
$$;

revoke all on function public.cast_debate_vote(uuid, uuid) from public;
grant execute on function public.cast_debate_vote(uuid, uuid) to authenticated, service_role;

comment on function public.cast_debate_vote(uuid, uuid) is
  'Cast a community debate vote. Voter = auth.uid(); ap_at_vote_time is read from users.current_ap server-side (never client-supplied) so the AP-weighted tally weight cannot be forged. Enforces the open votable round (payload state=awaiting_final_vote), the deadline, and participation in one transaction. Replaces the dropped debate_votes_insert_self policy (#114, H3 pattern).';

commit;

-- Down (reference, not auto-run): NB rolling back REOPENS #114 — it restores the
-- forgeable-ap_at_vote_time client insert path. Only roll back if the RPC caller
-- (castVote) is reverted in lockstep.
--   begin;
--   drop function if exists public.cast_debate_vote(uuid, uuid);
--   create policy debate_votes_insert_self on public.debate_votes for insert to authenticated
--     with check (public.is_self(voter_user_id));
--   commit;
