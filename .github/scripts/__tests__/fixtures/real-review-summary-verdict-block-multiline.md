# Security Review

## Findings

**[HIGH]** service-role key referenced in `apps/web/lib/supabase-admin.ts`. Reaches the client bundle at build time.

## Summary verdict

**BLOCK**

Move the admin client to `apps/workers/` and have the web app call it via a signed internal RPC. Do not merge until the client bundle grep for `SUPABASE_SERVICE_ROLE_KEY` returns zero matches.
