-- Migration: debate_args_submit_rpc
--
-- Up:   route debate_arguments INSERTs through a SECURITY DEFINER RPC
--       and drop the client-facing `debate_args_insert_self` policy.
--       The policy's with-check is `is_self(user_id)` only -- bare
--       ownership -- while an accepted row's validity depends on four
--       invariants RLS cannot express (sweep F2,
--       docs/audits/2026-11-insert-policy-sweep.md):
--         (a) round in `awaiting_arguments` state
--         (b) not past round.deadline_at
--         (c) not the verdict round (round_no < 3)
--         (d) caller is a participant of the round's battle.
--       A hostile client that skips the tRPC resolver could today
--       POST to /rest/v1/debate_arguments and insert past the
--       deadline, on a `revealed` or `scored` round, or without
--       being a participant at all (the unique (round_id, user_id)
--       index only blocks a same-seat second submission).
--
--       Same H3 pattern as place_prediction (20260729120000, PR
--       #107) and cast_debate_vote (20260730120000, PR #114): derive
--       the actor from auth.uid(), snapshot authoritative state
--       server-side, and enforce every coupled invariant in one
--       transaction. The RPC becomes the only writer; the matching
--       table INSERT grant to `authenticated` is revoked so even a
--       future accidental policy recreation stays unreachable.
--
--       Also revokes the unreachable INSERT grant on
--       `public.battle_participants` left behind by sweep F1
--       (20261127000000 dropped `bp_insert_self` but kept the grant
--       -- the matchmaker writes as service_role). Security-reviewer
--       note on #322.
--
-- Down: revert to the direct-client-insert path. Rolling back
--       REOPENS the F2 hole -- only use as a same-day unblock.
--         begin;
--         drop function if exists public.submit_debate_argument(uuid, text);
--         create policy debate_args_insert_self on public.debate_arguments
--           for insert to authenticated with check (public.is_self(user_id));
--         grant insert on public.debate_arguments to authenticated;
--         grant insert on public.battle_participants to authenticated;
--         commit;
--
-- Timestamp 20261128000000 -- strictly greater than the current
-- prod/local max (20261127000000).

begin;

-- (a) Drop the direct client insert path. The RPC below becomes the
--     only writer. SELECT policies (debate_args_select_own,
--     debate_args_select_revealed) stay -- read surface unchanged.
drop policy if exists debate_args_insert_self on public.debate_arguments;

-- (b) Revoke the now-unreachable INSERT grant -- defence-in-depth so
--     a future accidental re-create of the policy still can't be hit
--     from an authenticated JWT.
revoke insert on public.debate_arguments from authenticated;

-- (c) Follow-on from sweep F1 / security-reviewer note on #322:
--     bp_insert_self was dropped in 20261127000000, so the matching
--     table INSERT grant to `authenticated` is unreachable. The
--     matchmaker writes as service_role (bypasses RLS and grants).
revoke insert on public.battle_participants from authenticated;

-- (d) The argument RPC. Submitter = auth.uid() (never client-supplied).
--     Round state, deadline, verdict-round gate, and participation are
--     all read server-side from authoritative tables in one tx.
create or replace function public.submit_debate_argument(
  p_round_id uuid,
  p_text     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user       uuid;
  v_battle_id  uuid;
  v_round_no   integer;
  v_payload    jsonb;
  v_deadline   timestamptz;
  v_state      text;
  v_len        integer;
  v_arg_id     uuid;
begin
  -- (1) Auth. EXECUTE is granted to authenticated/service_role only;
  --     the inline guard is defence-in-depth.
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_text is null then
    raise exception 'text required' using errcode = '22023';
  end if;

  -- (2) Length -- matches the column CHECK (100..2000). Enforced here
  --     for a clean application-layer error instead of a 23514.
  v_len := char_length(p_text);
  if v_len < 100 or v_len > 2000 then
    raise exception 'text must be 100..2000 chars (got %)', v_len using errcode = '22023';
  end if;

  -- (3) Round must exist. Read battle_id + round_no + state + deadline
  --     server-side; never trust client-side mirrors.
  select r.battle_id, r.round_no, r.payload, r.deadline_at
    into v_battle_id, v_round_no, v_payload, v_deadline
    from public.battle_rounds r
    where r.id = p_round_id;
  if not found then
    raise exception 'round not found' using errcode = 'P0002';
  end if;

  -- (4) Verdict round (round_no=3) is runner-owned -- never a submission target.
  if v_round_no >= 3 then
    raise exception 'cannot submit on verdict round' using errcode = 'DA001';
  end if;

  -- (5) Round must be accepting arguments. The runner transitions state
  --     from awaiting_arguments -> revealed/awaiting_final_vote/scored;
  --     only the first accepts submissions.
  v_state := coalesce(v_payload->>'state', '');
  if v_state <> 'awaiting_arguments' then
    raise exception 'round is not accepting arguments (state=%)', v_state using errcode = 'DA002';
  end if;

  -- (6) Deadline (if set) must not have passed. Null deadline = no cap
  --     (matches the prior tRPC behaviour -- open_debate rounds always
  --     set one; trivia/future modes may not).
  if v_deadline is not null and v_deadline <= now() then
    raise exception 'round deadline has passed' using errcode = 'DA003';
  end if;

  -- (7) Participation. The unique (round_id, user_id) index blocks a
  --     same-seat second submission at the DB layer; this check blocks
  --     a non-participant seat-0/seat-1 insert from ever reaching that
  --     index, which is the F2 bypass.
  if not exists (
    select 1 from public.battle_participants p
    where p.battle_id = v_battle_id and p.user_id = v_user
  ) then
    raise exception 'only debate participants can submit arguments' using errcode = 'DA004';
  end if;

  -- (8) Insert. unique (round_id, user_id) collapses to 23505 on retry.
  begin
    insert into public.debate_arguments (battle_id, round_id, user_id, text)
    values (v_battle_id, p_round_id, v_user, p_text)
    returning id into v_arg_id;
  exception when unique_violation then
    raise exception 'already submitted an argument this round' using errcode = '23505';
  end;

  return v_arg_id;
end;
$$;

revoke all on function public.submit_debate_argument(uuid, text) from public;
grant execute on function public.submit_debate_argument(uuid, text) to authenticated, service_role;

comment on function public.submit_debate_argument(uuid, text) is
  'Submit a debate argument. Submitter = auth.uid() (never client-supplied). Enforces round state (awaiting_arguments), round.deadline_at, non-verdict round (round_no<3), and battle-participant membership in one transaction. Replaces the dropped debate_args_insert_self policy (sweep F2, docs/audits/2026-11-insert-policy-sweep.md; H3 pattern per place_prediction / cast_debate_vote).';

commit;
