-- Migration: covering indexes for the invariant-check monitor queries.
-- Up:   create two partial / plain btree indexes that support the exact
--       predicates + ORDER BY of the two SQL_* query strings in
--       apps/workers/src/jobs/invariant-check.ts.
-- Down:
--   drop index if exists public.battles_invariant_monitor_idx;
--   drop index if exists public.predictions_invariant_monitor_idx;
--
-- Motivation. invariant-check runs every N minutes (pg_cron, migration
-- 20260929200000) and the two queries scan all settled battles / all
-- recent predictions to find rows whose AP ledger side is missing.
-- Today, with 0 rows in prod, the planner picks acceptable paths
-- (bitmap-scan on battles_status_idx for Q1; seq-scan on predictions
-- for Q2 — see the EXPLAIN block in the PR body). Once settled battles
-- and placed predictions reach steady-state, those paths become O(n)
-- scans every pg_cron tick. Partial / covering btrees over the exact
-- predicates close the growth curve before it matters.
--
-- Shape rationale.
--
-- (1) battles_invariant_monitor_idx — partial index on (ended_at DESC)
--     with WHERE clause matching Q1 exactly: status='settled' AND
--     winner_user_id IS NOT NULL. The partial narrows the index to
--     only the rows the monitor cares about (practice-mode void-mode
--     and bot-wins fall outside), and the DESC ordering lets the
--     ORDER BY ... LIMIT 6 be served without a sort.
--
-- (2) predictions_invariant_monitor_idx — plain btree on
--     (created_at DESC). Q2 does NOT have a selective status filter
--     (ap_stake > 0 is nearly universal — the column CHECK rejects 0),
--     so a partial would buy nothing over the plain index. The DESC
--     ordering again lets the ORDER BY ... LIMIT 6 be served
--     directly.
--
-- IF NOT EXISTS so the migration is safe to re-apply. CREATE INDEX
-- (not CONCURRENTLY) because supabase CLI wraps migrations in a
-- transaction — concurrent indexes can't run inside one. The locks
-- held are brief (both tables are small; status='settled' is a tight
-- partial) and migrations run in a low-traffic window regardless. If
-- either table grows large enough to make the brief ACCESS EXCLUSIVE
-- lock problematic, convert this to a two-step migration (empty
-- migration + out-of-band CONCURRENTLY) at that point.

begin;

create index if not exists battles_invariant_monitor_idx
  on public.battles (ended_at desc)
  where status = 'settled' and winner_user_id is not null;

comment on index public.battles_invariant_monitor_idx is
  'Supports SQL_BATTLE_SETTLED_MISSING_AP in apps/workers/src/jobs/'
  'invariant-check.ts. Partial on (status=''settled'' AND winner_user_id '
  'IS NOT NULL); DESC on ended_at serves the LIMIT 6 ORDER BY directly.';

create index if not exists predictions_invariant_monitor_idx
  on public.predictions (created_at desc);

comment on index public.predictions_invariant_monitor_idx is
  'Supports SQL_PREDICTION_MISSING_STAKE in apps/workers/src/jobs/'
  'invariant-check.ts. Plain btree on (created_at DESC); the ap_stake>0 '
  'predicate is near-universal (CHECK rejects 0) so a partial buys nothing.';

commit;
