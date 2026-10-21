-- Migration: 18+ age gate.
--
-- Adds self-attested age verification to `public.users`. The RPC
-- `attest_age(p_birth_date date)` is the only writer; it receives
-- the user's self-reported date of birth from the /onboard/age page,
-- computes age server-side against `current_date`, stamps
-- `age_verified_at` on 18+ or `age_blocked_at` on <18, and NEVER
-- stores the date of birth itself (data minimisation — the operator
-- contract is explicit on this).
--
-- Once `age_blocked_at` is set, the RPC refuses further attempts
-- from that account. Terminal state. No reversion path.
--
-- Bots (`is_bot=true`) bypass the gate — they are synthetic accounts
-- with no human subject to the 18+ requirement. Existing bots are
-- backfilled to `age_verified_at = now()`. New bot rows are auto-
-- stamped by a BEFORE INSERT trigger.
--
-- `get_user_self()` is replaced to include the two new nullable
-- timestamptz columns; the layout + tRPC middleware read them to
-- decide the redirect / block posture.
--
-- Up:
--   alter table public.users
--     add column age_verified_at timestamptz,
--     add column age_blocked_at timestamptz,
--     add constraint users_age_mutex ...
--   backfill: update users set age_verified_at = now() where is_bot;
--   create trigger stamp_bot_age_verified before insert on users;
--   create function attest_age(date);
--   drop + recreate get_user_self() with the two new columns.
--
-- Down:
--   drop function attest_age(date);
--   drop + recreate get_user_self() without the two new columns;
--   drop trigger stamp_bot_age_verified_trigger on users;
--   drop function stamp_bot_age_verified();
--   alter table users drop constraint users_age_mutex;
--   alter table users drop column age_blocked_at, drop column age_verified_at.

begin;

-- ---------------------------------------------------------------------------
-- 1) New columns + mutex invariant.
-- ---------------------------------------------------------------------------

alter table public.users
  add column age_verified_at timestamptz,
  add column age_blocked_at  timestamptz;

-- An account can be verified OR blocked, never both. The RPC enforces
-- this at write time, but the column CHECK is defence-in-depth against
-- any future direct-SQL migration that could leave the invariant
-- half-stamped.
alter table public.users
  add constraint users_age_mutex
  check (age_verified_at is null or age_blocked_at is null);

comment on column public.users.age_verified_at is
  'Server-stamped timestamp when the user self-attested as 18+ via '
  'the attest_age() RPC. Never settable from a client-direct PostgREST '
  'write (no app-role GRANT and no with-check INSERT policy). '
  'Immutable once set — the RPC refuses to update a non-null row.';

comment on column public.users.age_blocked_at is
  'Server-stamped timestamp when the user self-attested as <18. '
  'Terminal state; the attest_age() RPC refuses further attempts from '
  'this account. The /not-eligible page is the only post-block surface.';

-- ---------------------------------------------------------------------------
-- 2) Bot bypass: synthetic accounts are not subject to the 18+ gate.
-- ---------------------------------------------------------------------------

-- Backfill existing bots. The post-condition is: no bot row has
-- `age_verified_at IS NULL`. The /layout.tsx gate for a bot JWT (if
-- that path ever runs) will then pass the age check and proceed.
update public.users
   set age_verified_at = now()
 where is_bot = true;

-- BEFORE INSERT trigger: any new bot row auto-stamps age_verified_at
-- at insert time. The handle_new_user trigger inserts the shell row;
-- this trigger runs AFTER that and before the row is finalised.
-- Scoped to is_bot=true so human signups are unaffected.
create or replace function public.stamp_bot_age_verified()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_bot and new.age_verified_at is null then
    new.age_verified_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_bot_age_verified_trigger on public.users;
create trigger stamp_bot_age_verified_trigger
  before insert on public.users
  for each row execute function public.stamp_bot_age_verified();

-- ---------------------------------------------------------------------------
-- 3) attest_age(p_birth_date date) — the one writer.
-- ---------------------------------------------------------------------------
-- Returns a jsonb outcome:
--   { outcome: 'verified' | 'blocked' | 'already_verified' }
-- Raises on auth / bad-input / terminal-block / missing-user.
--
-- NEVER writes `p_birth_date` to the database. The server computes age
-- from `age(current_date, p_birth_date)` and discards the raw date at
-- the end of the function. The caller's self-reported DOB survives
-- only as a bool-shaped outcome at persist time.
--
-- Terminal-block posture: once `age_blocked_at` is set, every
-- subsequent call for this user raises errcode 'P0001' with the message
-- 'age-gate: no further attempts'. The web client renders /not-eligible
-- regardless; this guard closes the direct-PostgREST + CLI path.

create function public.attest_age(p_birth_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id   uuid := auth.uid();
  v_age       int;
  v_row       public.users%rowtype;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_birth_date is null then
    raise exception 'age-gate: birth_date is required'
      using errcode = '22023';  -- invalid_parameter_value
  end if;

  -- Reject nonsense DOBs. A date >= today or absurdly far in the past
  -- is almost certainly a mis-click; raise invalid_parameter_value so
  -- the client can re-prompt instead of mis-stamping blocked. The
  -- `<= '1900-01-01'` floor is well below the oldest known human age.
  if p_birth_date >= current_date or p_birth_date <= date '1900-01-01' then
    raise exception 'age-gate: birth_date out of range'
      using errcode = '22023';
  end if;

  select * into v_row from public.users where id = v_user_id;
  if not found then
    raise exception 'age-gate: user row missing'
      using errcode = 'P0002';  -- no_data_found
  end if;

  -- Terminal-block guard. Any further attempt by a blocked account
  -- is refused — even an attempt with a 100%-adult DOB. The operator
  -- contract: "no hints about lying".
  if v_row.age_blocked_at is not null then
    raise exception 'age-gate: no further attempts'
      using errcode = 'P0001';  -- raise_exception, generic
  end if;

  -- Idempotent no-op for an already-verified row. The web client's
  -- gated redirect won't normally land here, but a retry after a
  -- transient network error should not fail; return a soft outcome.
  if v_row.age_verified_at is not null then
    return jsonb_build_object('outcome', 'already_verified');
  end if;

  v_age := extract(year from age(current_date, p_birth_date))::int;

  if v_age >= 18 then
    update public.users
       set age_verified_at = now(),
           updated_at      = now()
     where id = v_user_id
       and age_verified_at is null
       and age_blocked_at is null;
    -- The `age_verified_at is null and age_blocked_at is null` guard
    -- in the UPDATE closes the TOCTOU between the `select` above and
    -- this write. If a concurrent attestation beat us, the UPDATE
    -- touches zero rows and the function still returns a sensible
    -- outcome (fetch-after-write would be excessive overhead; the
    -- client's next page load will see the final state via
    -- get_user_self()).
    return jsonb_build_object('outcome', 'verified');
  else
    update public.users
       set age_blocked_at = now(),
           updated_at     = now()
     where id = v_user_id
       and age_verified_at is null
       and age_blocked_at is null;
    return jsonb_build_object('outcome', 'blocked');
  end if;
end;
$$;

revoke all on function public.attest_age(date) from public, anon;
grant execute on function public.attest_age(date) to authenticated, service_role;

comment on function public.attest_age(date) is
  'Self-attested 18+ gate. Caller submits a date of birth; the server '
  'computes age and stamps age_verified_at (>=18) or age_blocked_at '
  '(<18) on public.users. Never writes the date of birth. Terminal: '
  'a blocked account refuses further attempts. The /onboard/age page '
  'is the sole UI caller.';

-- ---------------------------------------------------------------------------
-- 4) get_user_self() — include the two new columns.
-- Signature changes (return type widens), so DROP + CREATE (not
-- CREATE OR REPLACE). The replacement body is byte-identical except
-- for the two added columns at the end of the SELECT list and the
-- RETURNS TABLE list.
-- ---------------------------------------------------------------------------

drop function if exists public.get_user_self();
create function public.get_user_self()
returns table (
  id uuid,
  handle extensions.citext,
  display_name text,
  avatar_url text,
  current_ap integer,
  tier_id smallint,
  is_bot boolean,
  onboarded_at timestamptz,
  notification_preferences jsonb,
  age_verified_at timestamptz,
  age_blocked_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    u.id,
    u.handle,
    u.display_name,
    u.avatar_url,
    u.current_ap,
    u.tier_id,
    u.is_bot,
    u.onboarded_at,
    u.notification_preferences,
    u.age_verified_at,
    u.age_blocked_at
  from public.users u
  where u.id = auth.uid();
$$;

revoke all on function public.get_user_self() from public;
grant execute on function public.get_user_self() to authenticated;

commit;
