-- Catalog test: migration 20261129000000_comments_select_grants.sql.
-- The comments hotfix grants SELECT on public.comments +
-- public.comment_likes to `authenticated` so the RLS SELECT policies
-- on those tables can actually apply (project-wide table grants are
-- explicit — see 20260617160000_public_schema_grants_audit.sql).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- T1 — SELECT privilege present on both tables for `authenticated`.
do $$
declare
  v_c boolean;
  v_l boolean;
begin
  v_c := has_table_privilege('authenticated', 'public.comments',      'SELECT');
  v_l := has_table_privilege('authenticated', 'public.comment_likes', 'SELECT');
  if v_c is not true then
    raise exception 'T1 FAIL: authenticated lacks SELECT on public.comments';
  end if;
  if v_l is not true then
    raise exception 'T1 FAIL: authenticated lacks SELECT on public.comment_likes';
  end if;
  raise notice 'T1 PASS: SELECT granted on comments + comment_likes';
end $$;

-- T2 — INSERT/UPDATE/DELETE are NOT granted on either table. Writes
-- route through the SECURITY DEFINER RPCs (create_comment /
-- delete_own_comment / toggle_comment_like); the role must never
-- hold a direct write privilege.
do $$
declare
  t text;
  p text;
begin
  for t in select unnest(array['public.comments', 'public.comment_likes']) loop
    for p in select unnest(array['INSERT', 'UPDATE', 'DELETE']) loop
      if has_table_privilege('authenticated', t, p) then
        raise exception 'T2 FAIL: authenticated has % on % — must be RPC-only', p, t;
      end if;
    end loop;
  end loop;
  raise notice 'T2 PASS: no INSERT/UPDATE/DELETE on comments or comment_likes for authenticated';
end $$;

-- T3 — RLS still enabled on both tables.
do $$
declare
  v_c boolean;
  v_l boolean;
begin
  select c.relrowsecurity into v_c from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname='comments';
  select c.relrowsecurity into v_l from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname='comment_likes';
  if v_c is not true then raise exception 'T3 FAIL: RLS off on public.comments'; end if;
  if v_l is not true then raise exception 'T3 FAIL: RLS off on public.comment_likes'; end if;
  raise notice 'T3 PASS: RLS still enabled on both tables';
end $$;

rollback;
\echo 'ALL comments_select_grants ASSERTIONS PASSED (T1-T3)'
