-- Up / Down
--
-- Up:   drop the `bp_insert_self` client-side INSERT policy on
--       public.battle_participants. The only intended writer is the
--       workers matchmaker, which uses the service role and bypasses
--       RLS; the web and api codebases do not insert into this table
--       via a user-scoped Supabase client (see insert-policy sweep
--       finding F1, docs/audits/2026-11-insert-policy-sweep.md).
--
--       The policy body is `is_self(user_id)` only — which lets any
--       authenticated JWT POST to PostgREST and seat itself in any
--       battle regardless of status, seat count, or AP band. H3-shape
--       hole: the validity of a `battle_participants` row depends on
--       invariants RLS cannot express (battle status, seat vacancy,
--       AP band, entry_ap debit coupled to the seat claim). The
--       matchmaker already enforces these server-side; dropping the
--       policy closes the direct-PostgREST bypass.
--
--       SELECT policies (`bp_select_self`,
--       `battle_participants_select_open_debate_observers`) stay —
--       the read surface is unaffected. No UPDATE/DELETE policies
--       exist on this table, so RLS's deny-by-default posture already
--       closes those surfaces. RLS stays enabled.
--
-- Down: recreate `bp_insert_self` verbatim as it existed in migration
--       20260420090004_battles_and_trivia.sql:
--
--         create policy bp_insert_self on public.battle_participants
--           for insert to authenticated
--           with check (public.is_self(user_id));
--
--       Rolling back restores the H3-shape hole; only use as a
--       same-day unblock for a stuck client, never leave it in place.
--
-- Timestamp 20261127000000 — strictly greater than the current prod
-- max (20261126000000) and the latest local migration
-- (20261125000000).

begin;

drop policy if exists bp_insert_self on public.battle_participants;

commit;
