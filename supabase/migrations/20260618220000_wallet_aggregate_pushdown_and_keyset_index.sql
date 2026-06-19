-- Migration: wallet_aggregate_pushdown_and_keyset_index
-- Up:   (a) SECURITY INVOKER function public.wallet_ghost_earnings()
--       that sums the caller's `ghost_credit` deltas inside the DB
--       (closes H3); (b) replace ap_tx_user_recent_idx with a
--       composite (user_id, created_at desc, id desc) so the
--       transactions keyset cursor is index-only and tie-stable
--       (closes H2).
-- Down: drop the function + revoke; recreate the original two-column
--       index. See ROLLBACK SCRIPT below.
--
-- Why this exists
-- ---------------
-- The wallet router (`apps/api/src/routers/wallet.ts`) carries two
-- queue HIGHs that share a table (public.ap_transactions) and a
-- defence shape (self-only reads pushed into SQL where Postgres can
-- enforce them at the planner + RLS layers rather than relying on
-- Node-side correctness).
--
-- (a) H3 — wallet.ghostEarnings did
--       select('delta').eq('user_id', me).eq('reason', 'ghost_credit')
--     then `data.reduce((acc, r) => acc + r.delta, 0)`. Every single
--     ghost_credit row crossed the wire to Node — unbounded in the
--     write count, latency-sensitive in serialization. The aggregate
--     is naturally a SQL operation; pushing it into a SECURITY
--     INVOKER function:
--
--       - Confines the entire scan to Postgres — only one bigint
--         crosses the wire.
--       - Leaves RLS in charge: SECURITY INVOKER executes as the
--         caller's role, so ap_tx_select_self (using is_self(user_id))
--         scopes the read to auth.uid() automatically.
--       - Keeps an explicit `where user_id = auth.uid()` clause in
--         the function body as defence in depth — RLS and the WHERE
--         must both pass, and the WHERE makes intent auditable
--         without reading the policy.
--       - Returns bigint so a lifetime sum cannot overflow integer
--         (delta is int; SUM of many positive int rows can exceed
--         2^31 even if no single row does). bigint stays well under
--         MAX_SAFE_INTEGER for any realistic tenure.
--       - coalesce(..., 0) collapses the empty-table case to 0
--         instead of NULL.
--       - search_path='' + schema-qualified everything blocks any
--         schema-shadowing attack against a session that toggled
--         search_path before invoking.
--
-- (b) H2 — wallet.transactions was already Zod-capped at limit ≤ 100
--     and used a keyset cursor, but the cursor was `created_at` only.
--     Two rows written in the same microsecond (rare but possible —
--     bot-seed bursts, rapid battle settles) created a tie boundary
--     where `.lt('created_at', cursor)` could either skip or
--     duplicate rows. The fix is a composite (created_at, id) keyset:
--
--       order by (created_at desc, id desc)
--       where  (created_at, id) < (cursor.createdAt, cursor.id)
--
--     PostgREST renders the SQL tuple comparison as a two-clause OR
--     (the router uses `created_at < X OR (created_at = X AND id < Y)`).
--     The existing ap_tx_user_recent_idx (user_id, created_at desc)
--     cannot tie-break inside the index leaf — Postgres would have to
--     sort the matching rows by id at query time. Re-creating with a
--     third key (id desc) makes the keyset cursor index-only and
--     tie-stable. Every other existing query that prefix-scans on
--     (user_id, created_at desc) is unaffected — the new index is a
--     strict superset.
--
--     INDEX REBUILD NOTE — dev has 0 rows so DROP + CREATE inside a
--     transaction is instant. On a populated production database the
--     same shape would need `CREATE INDEX CONCURRENTLY` outside a
--     transaction (preceded by `DROP INDEX CONCURRENTLY` of the old
--     one); revisit the rebuild strategy if/when ap_transactions
--     carries millions of rows before this migration applies to a
--     non-empty prod.
--
-- No application code changes are required outside the wallet router
-- — the web client (`apps/web/app/(app)/wallet/page.tsx`) round-trips
-- the cursor opaquely via `useInfiniteQuery`'s `getNextPageParam`, so
-- the shape change from `string` → `{ createdAt, id }` passes through
-- transparently. `GhostEarningsCard.tsx` consumes `{ totalAp: number }`
-- unchanged.
--
-- Service-role write paths (packages/ap-engine/src/settle.ts) are
-- unaffected — both INSERT under service_role, which bypasses RLS and
-- ignores the column-level grant story. The new function does NOT
-- shadow any existing function name (verified via pg_proc grep at
-- design time).
--
-- ---------------------------------------------------------------------------
-- ROLLBACK SCRIPT (run as postgres / supabase-admin)
-- ---------------------------------------------------------------------------
-- begin;
-- drop index if exists public.ap_tx_user_recent_idx;
-- create index ap_tx_user_recent_idx
--   on public.ap_transactions (user_id, created_at desc);
-- revoke execute on function public.wallet_ghost_earnings() from authenticated;
-- drop function if exists public.wallet_ghost_earnings();
-- commit;
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- (a) H3 — wallet_ghost_earnings() aggregate push-down
-- ---------------------------------------------------------------------------

create or replace function public.wallet_ghost_earnings()
returns bigint
language sql
security invoker
stable
set search_path = ''
as $$
  select coalesce(sum(delta)::bigint, 0)
  from public.ap_transactions
  where user_id = auth.uid()
    and reason = 'ghost_credit';
$$;

comment on function public.wallet_ghost_earnings() is
  'Self-only lifetime sum of ghost_credit deltas for the caller.
   SECURITY INVOKER — RLS scopes to auth.uid() via ap_tx_select_self;
   the explicit WHERE clause inside the function body is defence in
   depth. Coalesces empty to 0. Returns bigint so a lifetime sum
   cannot overflow integer.';

revoke all on function public.wallet_ghost_earnings() from public;
grant execute on function public.wallet_ghost_earnings() to authenticated;

-- ---------------------------------------------------------------------------
-- (b) H2 — composite (created_at, id) keyset index
-- ---------------------------------------------------------------------------

drop index if exists public.ap_tx_user_recent_idx;
create index ap_tx_user_recent_idx
  on public.ap_transactions (user_id, created_at desc, id desc);

commit;
