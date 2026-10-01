-- Migration: block changes to public.users.is_bot after row creation.
-- Up:   add a BEFORE UPDATE trigger `users_is_bot_immutable_check` on
--       public.users that raises when new.is_bot IS DISTINCT FROM
--       old.is_bot. Signup path writes via INSERT (handle_new_user
--       trigger), so creation is unaffected; flip-after-creation is
--       blocked absolutely.
-- Down: see `-- Rollback (reference, not auto-run):` block below —
--       drop trigger users_is_bot_immutable_check; drop function
--       public.users_is_bot_immutable().
--
-- Motivation (#149 — users.is_bot has no DB-layer immutability guard):
-- Issue #139's H1 bot-win exclusion relies on `winner.isBot` /
-- `loser.isBot` values read from `public.users.is_bot`. Enforcement
-- today is TypeScript-only in packages/ap-engine/src/settle.ts. A bug
-- or a compromised service-role bearer that runs
--   UPDATE public.users SET is_bot = false WHERE id = <bot uuid>
-- reopens the H1 gap for that user — subsequent battles the user wins
-- credit AP + potentially ghost dollars without any trigger, CHECK, or
-- grant blocking it.
--
-- This trigger closes the DB-layer gap:
--   * BEFORE UPDATE row trigger with a WHEN clause scoped to the
--     specific column change, so the trigger body is skipped entirely
--     on updates that leave is_bot alone (99.999% of writes).
--   * SECURITY DEFINER + explicit `search_path = ''` so a hostile
--     search_path from the caller cannot resolve `is_bot` to a shadow
--     column.
--   * RAISE EXCEPTION with a specific message naming the old and new
--     values + the user id — operators can diff the error against
--     ap_transactions on the user to see what the attacker tried.
--
-- Companion to the TypeScript tightening in the sibling PR for #149
-- (packages/ap-engine/src/validators.ts: drop .default(false) on
-- winner.isBot and loser.isBot). The two together make bot-exclusion
-- unforgeable from both ends.
--
-- Rollback (reference, not auto-run):
--   drop trigger if exists users_is_bot_immutable_check on public.users;
--   drop function if exists public.users_is_bot_immutable();

begin;

create or replace function public.users_is_bot_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Belt-and-suspenders: the trigger's WHEN clause already filters to
  -- is_bot-changing updates, but a future ALTER that removes the WHEN
  -- clause would send every UPDATE through here. The explicit check
  -- stays correct even if the trigger clause drifts.
  if new.is_bot is distinct from old.is_bot then
    raise exception
      'users.is_bot is immutable post-creation; refusing update from % to % for user %',
      old.is_bot, new.is_bot, new.id;
  end if;
  return new;
end;
$$;

-- Trigger: fires only when is_bot would actually change. The WHEN clause
-- means UPDATEs that touch any OTHER column (current_ap, tier_id, etc.)
-- pass through free with zero trigger overhead.
drop trigger if exists users_is_bot_immutable_check on public.users;
create trigger users_is_bot_immutable_check
before update on public.users
for each row
when (new.is_bot is distinct from old.is_bot)
execute function public.users_is_bot_immutable();

-- Function grant posture: SECURITY DEFINER functions default to
-- `GRANT EXECUTE TO public`. We don't want that — only the trigger
-- itself (which Postgres always resolves) should execute this function.
revoke all on function public.users_is_bot_immutable() from public;
-- Postgres still invokes the function via the trigger regardless of
-- grants, because trigger invocation runs as the table owner (which is
-- supabase_admin here); we revoke from public purely to keep the
-- surface clean and prevent an ad-hoc `select users_is_bot_immutable()`
-- call shape.

commit;
