-- Fix infinite-recursion RLS bug between `battle_participants` and `battles`.
--
-- (a) WHAT THIS FIXES — live latent production bug.
--
--     Before this migration, two policies formed a mutual-recursion cycle:
--
--       battle_participants_select_open_debate_observers   (migration 20260524120000)
--         USING ( exists (select 1 from public.battles b
--                         where b.id = battle_participants.battle_id
--                           AND b.mode = 'open_debate'
--                           AND b.status IN ('live','settled')) )
--
--       battles_select_participants                        (migration 20260420090004)
--         USING ( exists (select 1 from public.battle_participants p
--                         where p.battle_id = battles.id
--                           AND public.is_self(p.user_id)) )
--
--     Any `role=authenticated` SELECT on `battle_participants` evaluates the
--     observer policy → subqueries `battles` (RLS active) → evaluates
--     `battles_select_participants` → subqueries `battle_participants` (RLS
--     active) → evaluates the observer policy again → 42P17 "infinite
--     recursion detected in policy for relation battle_participants".
--
--     Whether the recursion fires on a given query depends on PG's policy
--     evaluation order: OR-combined policies short-circuit when the planner
--     picks `bp_select_self` first, but that ordering is not guaranteed.
--     Empirically the recursion is intermittent — sometimes silent, sometimes
--     500 — on the three `role=authenticated` participant-fanout reads:
--
--       apps/api/src/routers/battles.ts:38   — battles.getBattle fans all participants
--       apps/api/src/routers/debates.ts:112  — debates.getBattle fans all participants
--       apps/api/src/routers/debates.ts:305  — debates.castVote step-2 reads all participants
--
--     Surfaced by the RLS integration test in supabase/tests/sql/
--     battle_participants_rls.test.sql (PR #74). The test ran as expected:
--     the simple `SELECT count(*)` under role=authenticated raised 42P17
--     before any assertion's count could be computed.
--
-- (b) HOW THIS FIXES IT — single SECURITY DEFINER helper that bypasses RLS
--     on `battles` via owner-bypass, cutting the
--     `battle_participants → battles` edge of the cycle (the reverse
--     `battles → battle_participants` edge stays — it's needed by
--     `battles_select_participants` for the participants-can-see-their-own-
--     battles invariant).
--
--     The helper is owned by the migration-runner role (`postgres`), which
--     also owns `public.battles`. PG's RLS rule: table owners bypass row
--     security unless the table has `FORCE ROW LEVEL SECURITY` set.
--     `public.battles` has `ENABLE ROW LEVEL SECURITY` (migration 0004) but
--     does NOT have `FORCE` — so the helper's `select … from public.battles`
--     runs without policy evaluation, returns a plain boolean, and the
--     observer policy's USING clause sees a leaf value with no further
--     subquery to recurse into.
--
--     Same mechanism the codebase already relies on in
--     `submit_trivia_answer` (migration 20260618180000 lines 141–148, which
--     explicitly documents the owner-bypass-of-non-FORCE-RLS contract).
--
-- (c) FUTURE-PROOFING — if a future migration adds
--     `ALTER TABLE public.battles FORCE ROW LEVEL SECURITY`, the owner-bypass
--     disappears and this helper will recurse again. The required fix in
--     that case is one of:
--       - add `SET LOCAL row_security = off` inside the function body
--         (requires the function owner to have the BYPASSRLS attribute, or
--         be a superuser — currently postgres in supabase local is neither,
--         confirmed by PR #72 which proved postgres lacks SUPERUSER); OR
--       - rewrite the helper to query a denormalized mirror that no policy
--         touches; OR
--       - remove `FORCE` on battles, accepting that owners bypass is the
--         intended semantics for this surface.
--     Any migration adding FORCE RLS to battles MUST update this helper
--     atomically — otherwise the recursion returns to production.

begin;

create or replace function public.is_battle_open_debate_observable(p_battle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.battles b
    where b.id = p_battle_id
      and b.mode = 'open_debate'
      and b.status in ('live', 'settled')
  );
$$;

comment on function public.is_battle_open_debate_observable(uuid) is
  'RLS helper: returns true when the battle is in the open_debate observer-
   visible state (mode=open_debate AND status IN live|settled). SECURITY
   DEFINER + owner-bypass-of-non-FORCE-RLS makes the inner read of
   public.battles policy-free, breaking the mutual-recursion cycle with
   battles_select_participants. See migration 20260622164814 header for
   the full design + FORCE-RLS future-proofing note.';

revoke execute on function public.is_battle_open_debate_observable(uuid) from public;
grant execute on function public.is_battle_open_debate_observable(uuid) to authenticated;

drop policy if exists battle_participants_select_open_debate_observers
  on public.battle_participants;

create policy battle_participants_select_open_debate_observers
  on public.battle_participants
  for select to authenticated
  using (public.is_battle_open_debate_observable(battle_id));

commit;
