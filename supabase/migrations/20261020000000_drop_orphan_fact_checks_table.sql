-- Migration: drop orphan `public.fact_checks` table.
--
-- Rationale (CLAUDE.md "Deferred / Known issues" note, 2026-10-14):
--   Migration 20260420090005 created `public.fact_checks` as a
--   skeleton (claim/topic/verdict/evidence/provider) that was never
--   wired up. PR 4.7 superseded it with the three-table shape
--   `fact_check_claims` + `fact_check_verdicts` + `fact_check_sources`.
--   The orphan has 0 rows on prod, no inbound FK references, no code
--   path reads or writes it.
--
-- Read-only pre-apply verification against prod (2026-10-14):
--   select count(*) from public.fact_checks;         → 0
--   select conname, conrelid::regclass from pg_constraint
--     where contype='f' and
--           confrelid='public.fact_checks'::regclass; → (0 rows)
--   grep for `from('fact_checks'` / `public.fact_checks` across
--     apps/, packages/, supabase/: matches only the 20260420090005
--     creation migration itself. No live code reads or writes it.
--
-- Prod max migration version confirmed read-only pre-apply:
--   20261018000000 (post-#221). New migration 20261020000000 sorts
--   strictly after the next queued migration (20261019000000,
--   PR C — pick_drop_eligible_candidates).
--
-- Up:
--   drop table if exists public.fact_checks cascade;
--
-- Down:
--   Irreversible — backup before applying. The table carried no rows
--   and no live writer; reverting the DROP is schema-only. To restore
--   the orphan skeleton, re-apply 20260420090005 verbatim — it was not
--   modified by this migration. The schema was superseded by PR 4.7's
--   fact_check_* trio (claims / verdicts / sources), so a revert would
--   restore an unused table shape, not a working fact-check surface.

begin;

drop table if exists public.fact_checks cascade;

commit;
