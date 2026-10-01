# Security Review

## Findings

**M-1 — Service-role key reachable from the client bundle.** `apps/web/lib/supabase/client.ts:14` imports `SUPABASE_SERVICE_ROLE_KEY` without the `NEXT_PUBLIC_` prefix guard; a bundle inspection would expose the key.

**M-2 — RLS insert policy accepts an un-debited stake.** `supabase/migrations/20260729120000_predictions.sql:42` adds a `predictions_insert_self` policy that doesn't validate `current_ap` against the staked amount.

Fix M-1 and M-2 before merge. Both findings are introduced by this PR; neither is pre-existing.

**BLOCK**
