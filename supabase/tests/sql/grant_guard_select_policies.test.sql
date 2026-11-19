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

-- T1 — no public.* table with a SELECT policy targeting `authenticated`
-- lacks the matching SELECT table privilege.
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
    if not has_table_privilege('authenticated', format('public.%I', r.tablename), 'SELECT') then
      violations := violations || format('  - %s%s', r.tablename, E'\n');
    end if;
  end loop;
  if length(violations) > 0 then
    raise exception
      E'T1 FAIL: public.* tables with a SELECT RLS policy targeting authenticated/public that lack GRANT SELECT TO authenticated:\n%',
      violations;
  end if;
  raise notice 'T1 PASS: every SELECT RLS policy on public.* has a paired SELECT GRANT for authenticated';
end $$;

-- T2 — same shape for `anon`: a policy targeting `anon` (directly or
-- through `public`) requires the matching SELECT privilege for anon.
-- Keeps the signed-out read paths honest.
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
    if not has_table_privilege('anon', format('public.%I', r.tablename), 'SELECT') then
      violations := violations || format('  - %s%s', r.tablename, E'\n');
    end if;
  end loop;
  if length(violations) > 0 then
    raise exception
      E'T2 FAIL: public.* tables with a SELECT RLS policy targeting anon/public that lack GRANT SELECT TO anon:\n%',
      violations;
  end if;
  raise notice 'T2 PASS: every SELECT RLS policy targeting anon on public.* has a paired SELECT GRANT for anon';
end $$;

rollback;
\echo 'ALL grant_guard_select_policies ASSERTIONS PASSED (T1-T2)'
