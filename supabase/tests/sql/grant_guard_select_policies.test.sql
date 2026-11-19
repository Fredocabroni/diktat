-- Catalog test: every public.* table with a SELECT RLS policy that
-- targets `authenticated` (directly or through `public`) must also
-- hold a SELECT table-privilege for `authenticated` — otherwise the
-- RLS policy is dead code and the client gets 42501.
--
-- Caught: the 2026-11-18 comments bug (prod 42501), fixed in
-- 20261129000000_comments_select_grants.sql + commit 5c7f560.
-- Catching it in CI prevents a repeat.
--
-- Rationale: `supabase/migrations/20260617160000_public_schema_grants_audit.sql`
-- revoked the default-everything grants and made table grants explicit.
-- From that point on every new table that ships a SELECT policy must
-- also ship the paired GRANT. This test is the guard-rail for the next
-- migration that forgets.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- Rationale for `has_any_column_privilege`:
-- A policy TO authenticated is useful even when the SELECT grant is
-- column-level only (e.g. public.users and public.fact_check_claims
-- ship intentional column-level grants to keep private columns out of
-- the authenticated surface — see 20260618120000_users_access_column_grants).
-- `has_table_privilege(..., 'SELECT')` returns false on column-only
-- grants and would false-positive here. `has_any_column_privilege`
-- returns true for BOTH table-level and column-level grants, which is
-- exactly the semantics we want: "can this role reach at least one
-- column through the RLS policy?"

-- T1 — no public.* table with a SELECT policy targeting `authenticated`
-- lacks SELECT on any column for `authenticated`.
do $$
declare
  r record;
  violations text := '';
begin
  for r in
    select distinct p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and p.cmd = 'SELECT'
      and ('authenticated' = any(p.roles) or 'public' = any(p.roles))
  loop
    if not has_any_column_privilege('authenticated', format('public.%I', r.tablename), 'SELECT') then
      violations := violations || format('  - %s%s', r.tablename, E'\n');
    end if;
  end loop;
  if length(violations) > 0 then
    raise exception
      E'T1 FAIL: public.* tables with a SELECT RLS policy targeting authenticated/public that lack any SELECT column grant for authenticated:\n%',
      violations;
  end if;
  raise notice 'T1 PASS: every SELECT RLS policy on public.* has a paired SELECT grant (table- or column-level) for authenticated';
end $$;

-- T2 — same shape for `anon`.
do $$
declare
  r record;
  violations text := '';
begin
  for r in
    select distinct p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and p.cmd = 'SELECT'
      and ('anon' = any(p.roles) or 'public' = any(p.roles))
  loop
    if not has_any_column_privilege('anon', format('public.%I', r.tablename), 'SELECT') then
      violations := violations || format('  - %s%s', r.tablename, E'\n');
    end if;
  end loop;
  if length(violations) > 0 then
    raise exception
      E'T2 FAIL: public.* tables with a SELECT RLS policy targeting anon/public that lack any SELECT column grant for anon:\n%',
      violations;
  end if;
  raise notice 'T2 PASS: every SELECT RLS policy targeting anon on public.* has a paired SELECT grant (table- or column-level) for anon';
end $$;

rollback;
\echo 'ALL grant_guard_select_policies ASSERTIONS PASSED (T1-T2)'
