-- Migration: extend public.battles.status enum to include 'void'.
--
-- Motivation (#127 H8): an open_debate that ends with zero votes AND an
-- AI tiebreaker that can't decide (or is unavailable) has no winner. The
-- workers today mark such battles `status='settled', winner_user_id=null`
-- and move on silently — see apps/workers/src/jobs/open-debate-runner.ts
-- around the `decided_by='unresolved'` path. That state is misleading:
-- from every downstream consumer's view a settled+null-winner battle
-- looks identical to a tie, and neither participant sees any signal.
--
-- Fix (split into two PRs, per the overnight rule):
--   PR 1 (this migration): extend the battles_status_check CHECK
--                          constraint to accept 'void'. No behavior
--                          change — no writer emits 'void' today.
--   PR 2 (open-debate-runner + UI): the code change that flips
--                                   unresolved debates to status='void'
--                                   and surfaces a "not enough
--                                   participation" state to both
--                                   participants. That PR depends on
--                                   THIS migration being applied first.
--
-- Invariant safety: the Q1 invariant monitor
-- (apps/workers/src/jobs/invariant-check.ts battle_settled_missing_ap)
-- filters on `b.status = 'settled'`. Void battles have status='void',
-- so Q1 does not apply to them. No AP row is expected for a void
-- battle — matches the fix design (no refund, no drafts).
--
-- Rollback (reference, not auto-run):
--   -- After ensuring no rows carry status='void':
--   -- update public.battles set status = 'cancelled' where status = 'void';
--   -- Then re-swap the CHECK constraint back:
--   -- alter table public.battles drop constraint battles_status_check;
--   -- alter table public.battles add constraint battles_status_check
--   --   check (status in ('queued','live','settled','cancelled'));

begin;

-- Drop and re-add the CHECK. The existing constraint name mirrors the
-- one from 20260420090004_battles_and_trivia.sql:11
-- (`status text not null default 'queued' check (status in
-- ('queued','live','settled','cancelled'))`), which Postgres auto-names
-- `battles_status_check`. `pg_get_constraintdef` on prod confirms the
-- name (verified read-only during recon).
alter table public.battles
  drop constraint if exists battles_status_check;

alter table public.battles
  add constraint battles_status_check
    check (status in ('queued','live','settled','cancelled','void'));

commit;
