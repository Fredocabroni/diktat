-- Defense-in-depth: enforce the two participant invariants on debate_votes
-- at the DB layer, atomically at INSERT, closing the TOCTOU window between
-- the castVote resolver's battle_participants read (debates.ts step 2) and
-- its debate_votes insert (step 3).
--   Invariant 1 (exclusion): voter_user_id MUST NOT be a participant in battle_id.
--   Invariant 2 (inclusion): vote_for_user_id MUST be a participant in battle_id.
-- The unique (battle_id, voter_user_id) constraint already handles double-votes;
-- this trigger handles the participant invariants, previously resolver-only.
--
-- SECURITY DEFINER so the check evaluates the TRUE participant set independent
-- of the caller's RLS visibility on battle_participants (correct even if RLS
-- policies change or a service-role path inserts). search_path pinned empty +
-- every reference schema-qualified to neutralize the DEFINER search-path attack.

create or replace function public.enforce_debate_vote_participation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.battle_participants
    where battle_id = new.battle_id and user_id = new.voter_user_id
  ) then
    raise exception using
      errcode = 'DK001',
      message = 'voter_user_id is a participant in this battle and cannot vote';
  end if;

  if not exists (
    select 1 from public.battle_participants
    where battle_id = new.battle_id and user_id = new.vote_for_user_id
  ) then
    raise exception using
      errcode = 'DK002',
      message = 'vote_for_user_id is not a participant in this battle';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_debate_vote_participation() from public;

create trigger debate_votes_enforce_participation
  before insert on public.debate_votes
  for each row
  execute function public.enforce_debate_vote_participation();
