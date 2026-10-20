# Security Review

## Findings

**H-1 — Service-role key reachable from the client bundle.** `apps/web/lib/supabase/client.ts:14` imports `SUPABASE_SERVICE_ROLE_KEY` without the `NEXT_PUBLIC_` prefix guard.

Fix H-1 before merge.

VERDICT: BLOCK
