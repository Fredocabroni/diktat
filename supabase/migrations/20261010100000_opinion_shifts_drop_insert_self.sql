-- #145 PR C of 3 — drop the client-side `opinion_shifts_insert_self` INSERT
-- policy now that the SECURITY DEFINER RPC `record_opinion_shift` (migration
-- 20261010000000, PR A) is the authoritative writer and the resolver has been
-- swapped to call it (PR B).
--
-- SELECT policy (`opinion_shifts_select_self`) stays — users still need to
-- read their own shifts to render Take 5 progress + change-of-mind UI. No
-- UPDATE or DELETE policy exists on the table, so by RLS's deny-by-default
-- posture both are already closed; this migration touches only the INSERT
-- surface.
--
-- Must apply AFTER PR B's resolver swap is live in prod. If the policy is
-- dropped while the resolver still uses `.from().insert()`, every tap raises
-- 42501 and Take 5 breaks for every real user. The merge-order gate in the
-- 2026-10-08 handoff pins this: dispatch deploy-migrations for THIS file only
-- after Railway shows `@diktat/api` RUNNING on the PR-B merge commit.
--
-- Timestamp 20261010100000 — strictly greater than 20261001070000 (prod max)
-- and 20261010000000 (PR A). Follows the pre-merge-timestamp heuristic
-- landed in #176.
--
-- Rollback (reference, not auto-run):
--
--   create policy opinion_shifts_insert_self on public.opinion_shifts
--     for insert to authenticated
--     with check (public.is_self(user_id));
--
--   The policy body is `is_self(user_id)` only — recreating it restores the
--   original H3-shape hole #145 was filed against. Rolling back is a
--   same-day fix for a stuck client; don't leave it rolled back.

begin;

drop policy if exists opinion_shifts_insert_self on public.opinion_shifts;

commit;
