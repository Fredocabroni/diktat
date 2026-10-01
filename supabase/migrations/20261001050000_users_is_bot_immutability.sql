-- Migration: block changes to public.users.is_bot after row creation
-- AND fix handle_new_user to stamp is_bot at creation time.
-- Up:
--   1. CREATE OR REPLACE public.handle_new_user so the initial INSERT
--      into public.users sets is_bot = v_is_bot. Previously the column
--      was omitted and defaulted to false; the seed-bots.ts path then
--      flipped it to true in a follow-up UPDATE. The follow-up UPDATE
--      is incompatible with the immutability trigger below.
--   2. Add a BEFORE UPDATE trigger users_is_bot_immutable_check on
--      public.users that raises when new.is_bot IS DISTINCT FROM
--      old.is_bot. Creation (INSERT) is unaffected — the trigger is
--      UPDATE-only. Flip-after-creation is blocked absolutely from
--      service_role; SUPERUSER (postgres / supabase_admin) can still
--      bypass via `SET session_replication_role = replica` or
--      `ALTER TABLE ... DISABLE TRIGGER`, which is the correct scope
--      (no application-layer trigger can block direct DB access).
-- Down: see `-- Rollback (reference, not auto-run):` block below.
--
-- Motivation (#149): H1 bot-win exclusion relies on public.users.is_bot
-- being a trustworthy, write-once truth. Enforcement today is
-- TypeScript-only in packages/ap-engine/src/settle.ts. A bug or a
-- compromised service-role bearer that runs
--   UPDATE public.users SET is_bot = false WHERE id = <bot uuid>
-- reopens the H1 gap for that user. The DB-level guard closes the
-- bypass for the exact credential this threat model names
-- (service_role via a leaked SUPABASE_SERVICE_ROLE_KEY).
--
-- IMPORTANT — companion changes:
--   * The sibling validator PR (packages/ap-engine/src/validators.ts)
--     drops .default(false) on winner.isBot / loser.isBot so a caller
--     that forgets the field gets a Zod ValidationError instead of
--     silent misclassification.
--   * apps/api/scripts/seed-bots.ts stops writing is_bot in its
--     follow-up UPDATE — handle_new_user is now the sole writer, at
--     creation time, from the auth.users.raw_app_meta_data->>'is_bot'
--     signal that createUser({app_metadata: {is_bot: true}}) carries
--     to the trigger. The sidecar UPDATE now only overrides handle +
--     current_ap, both mutable columns.
--
-- Trigger function posture:
--   * language plpgsql, SECURITY INVOKER (explicitly — INVOKER is the
--     default for trigger functions but we spell it out so a future
--     edit that adds SECURITY DEFINER has to think about it). The
--     body only reads NEW.is_bot / OLD.is_bot — values the trigger
--     machinery hands over regardless of the invoking role; nothing
--     requires elevation. Keeping it INVOKER avoids widening blast
--     radius if the body ever grows a SELECT.
--   * search_path = '' is kept as hygiene for any future edit that
--     references a schema-qualified object. Note: the trigger
--     machinery resolves NEW.is_bot / OLD.is_bot from the physical
--     column, not via search_path, so this guard is forward-looking
--     only. (Round-1 security-reviewer LOW-1b: previous header
--     comment overstated the search_path protection.)
--
-- Rollback (reference, not auto-run):
--   drop trigger if exists users_is_bot_immutable_check on public.users;
--   drop function if exists public.users_is_bot_immutable();
--   create or replace function public.handle_new_user() ... (restore
--     20260420090009's body without the is_bot column on the INSERT);

begin;

-- (1) Stamp is_bot at creation time. The function body mirrors
-- 20260420090009 verbatim except for the single `is_bot` column
-- addition on the public.users INSERT. v_is_bot was already computed
-- from raw_app_meta_data; this now plumbs it through to the row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_bot boolean := coalesce(new.raw_app_meta_data->>'is_bot', 'false') = 'true';
begin
  insert into public.users (id, handle, is_bot)
  values (
    new.id,
    'citizen_' || substr(replace(new.id::text,'-',''), 1, 10),
    v_is_bot
  )
  on conflict (id) do nothing;

  insert into public.streaks (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.wallets (user_id, provider, status)
  values (new.id, 'privy', 'active')
  on conflict (user_id) do nothing;

  insert into public.ap_transactions
    (user_id, delta, balance_after, reason, idempotency_key)
  values
    (new.id, 100, 100, 'admin_adjust', 'signup_grant:' || new.id::text)
  on conflict (idempotency_key) do nothing;

  if not v_is_bot then
    perform pg_notify('privy_provision', new.id::text);
  end if;

  return new;
end;
$$;

-- (2) Immutability guard. SECURITY INVOKER (explicit) — see header.
create or replace function public.users_is_bot_immutable()
returns trigger
language plpgsql
security invoker
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

drop trigger if exists users_is_bot_immutable_check on public.users;
create trigger users_is_bot_immutable_check
before update on public.users
for each row
when (new.is_bot is distinct from old.is_bot)
execute function public.users_is_bot_immutable();

revoke all on function public.users_is_bot_immutable() from public;

commit;
