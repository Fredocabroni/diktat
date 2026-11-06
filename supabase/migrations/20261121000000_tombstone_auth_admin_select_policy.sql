-- Migration: tombstone_auth_admin_select_policy
--
-- Up: Add explicit `for select to supabase_auth_admin using (true)` policies
--     on public.age_block_tombstones and public.age_block_identity_tombstones.
--
--     Defense-in-depth for the Before-User-Created auth hook read path.
--     Both tombstone tables were created with RLS enabled and zero policies
--     (migration 20261115000000 for age_block_tombstones; migration
--     20261120000000 for age_block_identity_tombstones). public.hook_before_user_created
--     is SECURITY INVOKER (per Supabase hook contract) and runs as
--     supabase_auth_admin, so its SELECTs against both tables currently
--     succeed only because supabase_auth_admin has BYPASSRLS on the
--     Supabase platform. If that role attribute is ever dropped
--     (routine role hygiene, project restore, future Supabase change),
--     both lookups return zero rows and the hook silently fails open —
--     every previously-blocked signup is allowed. The hook's own WHEN
--     OTHERS catch does not fire because an empty result set is not an
--     exception, so there is no soft-fail warning either.
--
--     Fix: add an explicit SELECT policy to supabase_auth_admin on both
--     tables. The SELECT grant to supabase_auth_admin already exists
--     (migration 20261120000000 lines 204-205); this migration adds the
--     RLS policy that lets that grant actually produce rows without
--     relying on BYPASSRLS. End-user access posture is unchanged — anon
--     and authenticated remain fully denied (no policies for them, no
--     grants on the table), and service_role still bypasses RLS platform-side.
--
-- Down: drop both policies.
--   drop policy age_block_tombstones_select_auth_admin
--     on public.age_block_tombstones;
--   drop policy age_block_identity_tombstones_select_auth_admin
--     on public.age_block_identity_tombstones;

begin;

create policy age_block_tombstones_select_auth_admin
  on public.age_block_tombstones
  for select
  to supabase_auth_admin
  using (true);

create policy age_block_identity_tombstones_select_auth_admin
  on public.age_block_identity_tombstones
  for select
  to supabase_auth_admin
  using (true);

commit;
