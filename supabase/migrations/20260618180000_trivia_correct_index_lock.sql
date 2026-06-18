-- Migration: trivia_correct_index_lock
-- Up:   (a) UNIQUE (round_id, user_id) on trivia_answers; (b) revoke
--       table-level + per-column SELECT on correct_index and other
--       internal columns from authenticated, re-grant only the public
--       quiz-visible subset; (c) SECURITY DEFINER `submit_trivia_answer`
--       that records the answer atomically, grades server-side, and
--       returns (correct, latency_ms) — caller never reads correct_index.
-- Down: drop the constraint, restore the table-level GRANT SELECT on
--       trivia_questions, drop the function. See ROLLBACK SCRIPT below.
--
-- Why this exists
-- ---------------
-- PR #41's grants audit and the queue's M4 entry both flagged that
-- `trivia_questions.correct_index` is currently SELECTable by any
-- authenticated client via PostgREST:
--   GET /rest/v1/trivia_questions?select=id,correct_index&verified=eq.true
-- ...returns the entire answer key for all 184 verified questions on
-- the dev DB. Trivia battles are a cheat-sheet today. The legacy
-- grading path in `apps/api/src/routers/battles.ts:submitAnswer`
-- already does this read itself (line 184) to grade the answer, then
-- writes to `trivia_answers` via the service-role client — the read
-- via the user-scoped client is what makes the column reachable from
-- any client at all, not just the router.
--
-- This migration closes the leak in three coordinated changes:
--
-- (a) UNIQUE (round_id, user_id) on trivia_answers
--     The legacy router (with the comment "Today the table has no
--     such constraint but we map for forward compat" at battles.ts:215)
--     permitted repeated INSERTs for the same round — a cheat path on
--     top of the column leak, since `battle-runner.settle` counts every
--     `correct=true` row and a user could submit 4 times until one
--     lands. The unique constraint structurally closes this re-submit
--     vector. Verified safe to add: 0 rows on dev today (PR-time check).
--
-- (b) Tightened column grant on trivia_questions
--     Revokes the table-level SELECT + per-column SELECT on
--     `correct_index`. Re-grants ONLY the seven columns the client
--     legitimately needs to render a quiz round — `id, category,
--     prompt, choices, difficulty, source_url, verified`. Drops the
--     four internal columns the client never had a reason to read
--     anyway (`correct_index, verified_by_user_id, created_at,
--     updated_at`). A future column added to trivia_questions does
--     NOT inherit visibility; the allow-list is the audit surface.
--
-- (c) submit_trivia_answer SECURITY DEFINER RPC
--     The new single client-facing grading path. The function reads
--     `correct_index` server-side (SECURITY DEFINER bypasses the
--     column grant), grades, atomically inserts into trivia_answers,
--     and returns (correct, latency_ms). Locked to auth.uid() in the
--     body. Caller can NEVER observe correct_index by any path:
--       - Direct PostgREST SELECT → 42501 at the column-grant layer
--       - Calling the RPC → records a committed submission FIRST
--         (UNIQUE constraint enforces one-shot); they learn the
--         grading result only as a side effect of a row landing
--         in trivia_answers. No try-before-commit pattern works.
--
-- Service-role retains full table SELECT via the existing
-- `20260427_grant_service_role_public.sql` schema-wide grant —
-- `battle-runner.fetchQuestions` (round setup) and
-- `battle-runner.emitBotAnswer` (bot grading) continue working
-- unchanged. `apps/workers/src/jobs/trivia-gen.ts` (generation +
-- verifier) is service-role too; unaffected.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK SCRIPT (run as postgres / supabase-admin)
-- ---------------------------------------------------------------------------
-- begin;
-- -- Drop the SECURITY DEFINER grading RPC.
-- revoke execute on function public.submit_trivia_answer(uuid, uuid, smallint)
--   from authenticated;
-- drop function if exists public.submit_trivia_answer(uuid, uuid, smallint);
--
-- -- Restore the table-level GRANT SELECT on trivia_questions for
-- -- authenticated. The per-column grants this migration revoked were
-- -- auto-issued by the prior table-level grant, so the table-level
-- -- restore is sufficient — Postgres will re-apply per-column
-- -- visibility automatically.
-- revoke select (id, category, prompt, choices, difficulty, source_url, verified)
--   on public.trivia_questions from authenticated;
-- grant select on public.trivia_questions to authenticated;
--
-- -- Drop the UNIQUE constraint on trivia_answers (round_id, user_id).
-- alter table public.trivia_answers
--   drop constraint if exists trivia_answers_round_user_unique;
--
-- commit;
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- (a) UNIQUE (round_id, user_id) on trivia_answers
-- ---------------------------------------------------------------------------

alter table public.trivia_answers
  add constraint trivia_answers_round_user_unique
  unique (round_id, user_id);

-- ---------------------------------------------------------------------------
-- (b) Tighten column grant on trivia_questions
-- ---------------------------------------------------------------------------

revoke select on public.trivia_questions from authenticated;

grant select
  (id, category, prompt, choices, difficulty, source_url, verified)
  on public.trivia_questions to authenticated;

-- ---------------------------------------------------------------------------
-- (c) submit_trivia_answer SECURITY DEFINER RPC
-- ---------------------------------------------------------------------------

create or replace function public.submit_trivia_answer(
  p_battle_id    uuid,
  p_round_id     uuid,
  p_chosen_index smallint
)
returns table (correct boolean, latency_ms integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status            text;
  v_round_battle      uuid;
  v_round_created_at  timestamptz;
  v_question_id       uuid;
  v_correct_index     smallint;
  v_correct           boolean;
  v_latency_ms        integer;
begin
  -- (1) Auth. EXECUTE is granted to `authenticated` only and PUBLIC
  --     is revoked, but the inline NULL guard is defence-in-depth
  --     in case the role check is later loosened.
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- (2) Input range — defence in depth alongside the smallint CHECK
  --     constraint on trivia_answers.chosen_index >= 0.
  if p_chosen_index is null or p_chosen_index < 0 or p_chosen_index > 3 then
    raise exception 'chosen_index must be 0..3' using errcode = '22023';
  end if;

  -- (3) Caller must be a participant in this battle. Replaces the
  --     legacy router's implicit RLS-based check (battle_participants
  --     SELECT only returns the caller's own row); inside SECURITY
  --     DEFINER we check explicitly.
  if not exists (
    select 1 from public.battle_participants p
    where p.battle_id = p_battle_id and p.user_id = auth.uid()
  ) then
    raise exception 'not a participant' using errcode = '42501';
  end if;

  -- (4) Battle must be live.
  select status into v_status
    from public.battles
    where id = p_battle_id;
  if v_status is null then
    raise exception 'battle not found' using errcode = 'P0002';
  end if;
  if v_status <> 'live' then
    raise exception 'battle not accepting answers' using errcode = '22023';
  end if;

  -- (5) Round must belong to this battle; pull questionId + start time.
  select br.battle_id, br.created_at, (br.payload->>'questionId')::uuid
    into v_round_battle, v_round_created_at, v_question_id
    from public.battle_rounds br
    where br.id = p_round_id;
  if v_round_battle is null then
    raise exception 'round not found' using errcode = 'P0002';
  end if;
  if v_round_battle <> p_battle_id then
    raise exception 'round does not belong to battle' using errcode = '22023';
  end if;
  if v_question_id is null then
    raise exception 'round payload missing questionId' using errcode = 'P0002';
  end if;

  -- (6) Grade server-side. This is the ONLY read of correct_index by
  --     anything other than service-role workers — the column-grant
  --     change above makes
  --       ctx.db.from('trivia_questions').select('correct_index')
  --     return 42501. SECURITY DEFINER bypasses the column grant only
  --     inside this body, and the caller never sees v_correct_index
  --     in any return shape.
  select correct_index into v_correct_index
    from public.trivia_questions
    where id = v_question_id;
  if v_correct_index is null then
    raise exception 'question not found' using errcode = 'P0002';
  end if;

  v_correct := (p_chosen_index = v_correct_index);
  v_latency_ms := greatest(
    0,
    (extract(epoch from (now() - v_round_created_at)) * 1000)::integer
  );

  -- (7) Atomic insert. UNIQUE (round_id, user_id) raises 23505 on
  --     re-submission — we translate to the same code with a stable
  --     'already answered this round' message the router maps to
  --     CONFLICT. The contract: first submission wins, subsequent
  --     calls reject. Caller cannot use this RPC to "try" answers —
  --     each call commits a row.
  begin
    insert into public.trivia_answers(
      battle_id, round_id, user_id, question_id,
      chosen_index, correct, latency_ms
    )
    values (
      p_battle_id, p_round_id, auth.uid(), v_question_id,
      p_chosen_index, v_correct, v_latency_ms
    );
  exception when unique_violation then
    raise exception 'already answered this round' using errcode = '23505';
  end;

  return query select v_correct, v_latency_ms;
end;
$$;

comment on function public.submit_trivia_answer(uuid, uuid, smallint) is
  'One-shot recorded trivia submission. SECURITY DEFINER grading: caller
   can NEVER SELECT correct_index via PostgREST (column-grant excluded),
   only invoke this function which records the answer atomically and
   returns (correct, latency_ms). The UNIQUE (round_id, user_id)
   constraint on trivia_answers enforces one answer per round; the
   function raises 23505 on re-submission.';

revoke all on function public.submit_trivia_answer(uuid, uuid, smallint) from public;
grant execute on function public.submit_trivia_answer(uuid, uuid, smallint) to authenticated;

commit;
