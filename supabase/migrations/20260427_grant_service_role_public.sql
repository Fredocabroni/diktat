-- Migration: grant_service_role_public
-- Up: restore base table/sequence/function privileges on public to
--     service_role (fixes 42501 from workers post-RLS-only migrations
--     0001..0013) and set default privileges so future objects inherit.
-- Down: revoke matching grants + reset default privileges from service_role
--     (re-breaks worker writes — only run if rolling back Phase 3 workers).
--
-- Restore service_role privileges on public schema. Earlier migrations
-- created tables with RLS enabled but never granted base table privileges
-- to service_role, causing 42501 errors from worker processes (trivia
-- seed, AP settlement, matchmaking writes).

begin;

grant usage on schema public to service_role;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Apply to future objects too so this never bites again. Scoped FOR ROLE
-- postgres because that is the role the migration runner uses to create
-- objects in public; without it the default privileges only cover objects
-- created by the role running this statement.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

commit;
