-- Migration: age-block tombstone + Before-User-Created auth hook.
--
-- Purpose. Migrations 20261113000000 + 20261114000000 purge under-18
-- accounts 7 days after block. Without a persistent record of "this
-- email was blocked" there is nothing to stop the same person signing
-- up again with the same email and lying about their age on the second
-- attempt. Our /privacy page already promises we "may retain a minimal
-- record to enforce the age requirement". This migration lands that
-- minimal record and wires a Supabase "Before User Created" Postgres
-- auth hook that rejects a signup whose email hash is still-active-
-- tombstoned.
--
-- Minimum record: SHA-256 of the normalized email, created_at,
-- expires_at (default now() + 1 year). No user id, no IP, no DOB, no
-- email in cleartext — the email_hash alone is the full state.
--
-- Scope rules:
--   - Only the LIVE age-blocked branch of data_minimization_sweep
--     writes tombstones. Dry-run and the pre-launch (never-attested)
--     branch do NOT write tombstones. The pre-launch branch targets
--     users who never attested their age, so there is nothing to
--     enforce against them.
--   - Daily cleanup of expired tombstones runs inside the existing
--     sweep (both dry-run and live), not a new cron.
--
-- Auth hook (public.hook_before_user_created):
--   Rejects a signup whose email hashes into a non-expired tombstone.
--   Follows Supabase's documented hook contract (payload shape, return
--   shape, grants to supabase_auth_admin only — not SECURITY DEFINER).
--   Enable in Dashboard → Authentication → Hooks → Before user created
--   → Postgres → public.hook_before_user_created.
--
-- Up:
--   create table public.age_block_tombstones; RLS on; no policies.
--   grant all to supabase_auth_admin; revoke from everyone else.
--   create or replace function public.data_minimization_sweep(boolean)
--     adds tombstone-on-blocked-purge + expired-row cleanup.
--   create function public.hook_before_user_created(jsonb).
--
-- Down:
--   drop function public.hook_before_user_created(jsonb);
--   restore data_minimization_sweep body from 20261114000000.
--   drop table public.age_block_tombstones;

begin;

-- --------------------------------------------------------------------
-- (1) Tombstone table.
-- --------------------------------------------------------------------
-- email_hash is the primary key. The hash is computed as
-- encode(sha256(lower(btrim(email))::bytea), 'hex') — case- and
-- whitespace-insensitive. Supabase stores auth.users.email as citext
-- so case-insensitivity is already enforced upstream, but the hash
-- normalizes defensively so a stray leading space can never create a
-- "same email, different hash" bypass.
--
-- expires_at defaults to one year from created_at. The hook treats a
-- row with expires_at <= now() as absent (allows signup) and the
-- sweep deletes those rows daily.
--
-- RLS on, no policies. supabase_auth_admin has BYPASSRLS by default
-- (per Supabase auth-hook docs); service_role bypasses RLS. anon and
-- authenticated have zero visibility to this table on direct
-- PostgREST.
create table public.age_block_tombstones (
  email_hash  text        primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '1 year'
);

alter table public.age_block_tombstones enable row level security;
revoke all on public.age_block_tombstones from public, anon, authenticated;
grant all on public.age_block_tombstones to supabase_auth_admin;

-- Daily cleanup scans by expires_at; index it.
create index age_block_tombstones_expires_at_idx
  on public.age_block_tombstones (expires_at);

comment on table public.age_block_tombstones is
  'Age-block enforcement record. email_hash = '
  'encode(sha256(lower(btrim(email))::bytea), ''hex''). '
  'Written by public.data_minimization_sweep on the LIVE age-blocked '
  'purge only — never on dry-run, never on the pre-launch branch. '
  'Checked by public.hook_before_user_created to reject re-signup. '
  'RLS on, no policies — supabase_auth_admin bypasses RLS; '
  'service_role bypasses RLS; no end-user visibility.';

-- --------------------------------------------------------------------
-- (2) data_minimization_sweep: tombstone-on-blocked-purge + cleanup.
-- --------------------------------------------------------------------
-- Replaces the body from migration 20261114000000. Preserves every
-- gate (allowlist exclusion, candidate IDs, per-victim idempotency
-- scrub via public._scrub_user_ledger_keys) and adds:
--   * At the top (both dry-run and live): delete expired tombstones.
--   * In the LIVE age-blocked loop only: resolve the victim's email
--     from auth.users BEFORE the scrub+delete, hash it, and INSERT
--     into age_block_tombstones (on conflict do update expires_at).
--   * Pre-launch branch: unchanged — no tombstone writes.
--   * Return shape extended with tombstones_written +
--     tombstones_expired.
--
-- Why the tombstone insert sits inside the loop and BEFORE the delete:
-- the auth.users DELETE cascades through public.users and removes the
-- row we need to look up. The scrub helper already runs before the
-- delete for the same reason; the tombstone write slots in alongside
-- it. Same loop ordering (created_at asc) means first-N-UUID auditing
-- stays stable.
create or replace function public.data_minimization_sweep(p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch_date         date     := date '2026-10-21';
  v_pre_launch_window   interval := interval '30 days';
  v_block_window        interval := interval '7 days';
  v_tombstone_ttl       interval := interval '1 year';
  v_id_cap              int      := 500;
  v_blocked_count       int;
  v_pre_launch_count    int;
  v_deleted_blocked     int := 0;
  v_deleted_pre_launch  int := 0;
  v_tombstones_written  int := 0;
  v_tombstones_expired  int := 0;
  v_blocked_ids         jsonb := '[]'::jsonb;
  v_pre_launch_ids      jsonb := '[]'::jsonb;
  v_id                  uuid;
  v_email               text;
  v_hash                text;
begin
  -- (0) Expired-tombstone cleanup. Runs on EVERY sweep tick, dry-run
  -- or live. The daily cadence of the sweep provides the daily cadence
  -- of the cleanup — no second cron row needed.
  delete from public.age_block_tombstones
   where expires_at <= now();
  get diagnostics v_tombstones_expired = row_count;

  -- Count candidates for both policies up front — these numbers go
  -- into the log line regardless of dry-run. Allowlist exclusion
  -- applies here too.
  select count(*)
    into v_blocked_count
    from public.users u
    where u.is_bot = false
      and u.age_blocked_at is not null
      and u.age_blocked_at < now() - v_block_window
      and not exists (
        select 1 from public.sweep_protected_users spu
         where spu.user_id = u.id
      );

  select count(*)
    into v_pre_launch_count
    from public.users u
    where u.is_bot = false
      and u.age_verified_at is null
      and u.age_blocked_at is null
      and u.created_at < v_launch_date
      and current_date > v_launch_date + v_pre_launch_window
      and not exists (
        select 1 from public.sweep_protected_users spu
         where spu.user_id = u.id
      );

  if p_dry_run then
    -- Dry-run: return the first v_id_cap candidate UUIDs ordered by
    -- created_at. No deletes, no scrubs, no tombstone writes.
    select coalesce(jsonb_agg(cand.id order by cand.created_at), '[]'::jsonb)
      into v_blocked_ids
      from (
        select u.id, u.created_at
          from public.users u
         where u.is_bot = false
           and u.age_blocked_at is not null
           and u.age_blocked_at < now() - v_block_window
           and not exists (
             select 1 from public.sweep_protected_users spu
              where spu.user_id = u.id
           )
         order by u.created_at
         limit v_id_cap
      ) cand;

    select coalesce(jsonb_agg(cand.id order by cand.created_at), '[]'::jsonb)
      into v_pre_launch_ids
      from (
        select u.id, u.created_at
          from public.users u
         where u.is_bot = false
           and u.age_verified_at is null
           and u.age_blocked_at is null
           and u.created_at < v_launch_date
           and current_date > v_launch_date + v_pre_launch_window
           and not exists (
             select 1 from public.sweep_protected_users spu
              where spu.user_id = u.id
           )
         order by u.created_at
         limit v_id_cap
      ) cand;
  else
    -- (1) Age-blocked purge. Per victim:
    --   a. resolve email from auth.users, compute hash, upsert
    --      tombstone (write BEFORE delete so the lookup still works);
    --   b. scrub idempotency_keys via _scrub_user_ledger_keys;
    --   c. delete auth.users row — cascades through public.users and
    --      nulls ap_transactions.user_id.
    for v_id in
      select u.id
        from public.users u
       where u.is_bot = false
         and u.age_blocked_at is not null
         and u.age_blocked_at < now() - v_block_window
         and not exists (
           select 1 from public.sweep_protected_users spu
            where spu.user_id = u.id
         )
       order by u.created_at
    loop
      -- Tombstone write. Skip if email is somehow null/blank — the
      -- hash would be meaningless and the hook has no way to match.
      select au.email
        into v_email
        from auth.users au
       where au.id = v_id;

      if v_email is not null and btrim(v_email) <> '' then
        v_hash := encode(
          pg_catalog.sha256(lower(btrim(v_email))::bytea),
          'hex'
        );
        insert into public.age_block_tombstones (email_hash, expires_at)
        values (v_hash, now() + v_tombstone_ttl)
        on conflict (email_hash) do update
          set expires_at = excluded.expires_at;
        v_tombstones_written := v_tombstones_written + 1;
      end if;

      perform public._scrub_user_ledger_keys(v_id);
      delete from auth.users where id = v_id;
      v_deleted_blocked := v_deleted_blocked + 1;
      if v_deleted_blocked <= v_id_cap then
        v_blocked_ids := v_blocked_ids || to_jsonb(v_id);
      end if;
    end loop;

    -- (2) Pre-launch orphan purge. NO tombstone writes — the user
    -- never attested their age, so there is nothing to enforce against
    -- them on a future signup attempt.
    for v_id in
      select u.id
        from public.users u
       where u.is_bot = false
         and u.age_verified_at is null
         and u.age_blocked_at is null
         and u.created_at < v_launch_date
         and current_date > v_launch_date + v_pre_launch_window
         and not exists (
           select 1 from public.sweep_protected_users spu
            where spu.user_id = u.id
         )
       order by u.created_at
    loop
      perform public._scrub_user_ledger_keys(v_id);
      delete from auth.users where id = v_id;
      v_deleted_pre_launch := v_deleted_pre_launch + 1;
      if v_deleted_pre_launch <= v_id_cap then
        v_pre_launch_ids := v_pre_launch_ids || to_jsonb(v_id);
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'dry_run',                  p_dry_run,
    'blocked_candidates',       v_blocked_count,
    'pre_launch_candidates',    v_pre_launch_count,
    'deleted_blocked',          v_deleted_blocked,
    'deleted_pre_launch',       v_deleted_pre_launch,
    'tombstones_written',       v_tombstones_written,
    'tombstones_expired',       v_tombstones_expired,
    'blocked_candidate_ids',    v_blocked_ids,
    'pre_launch_candidate_ids', v_pre_launch_ids,
    'launch_date',              to_char(v_launch_date, 'YYYY-MM-DD'),
    'swept_at',                 to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- SECURITY posture unchanged: service_role only. create or replace
-- preserves grants, but belt-and-braces re-apply.
revoke all on function public.data_minimization_sweep(boolean)
  from public, anon, authenticated;
grant execute on function public.data_minimization_sweep(boolean) to service_role;

comment on function public.data_minimization_sweep(boolean) is
  'Pre-launch data minimization. Deletes age-blocked humans >7 days '
  'and pre-launch orphan humans >30 days post-launch. Bots and '
  'public.sweep_protected_users rows excluded. Dry-run returns '
  'candidate UUIDs (capped 500) under blocked_candidate_ids / '
  'pre_launch_candidate_ids. Live run scrubs idempotency_keys via '
  'public._scrub_user_ledger_keys() per victim BEFORE the auth.users '
  'DELETE cascades, and writes an email-hash tombstone into '
  'public.age_block_tombstones for the age-blocked branch only '
  '(not the pre-launch branch). Both dry-run and live clean up '
  'expired tombstones at the top of the function. service_role only.';

-- --------------------------------------------------------------------
-- (3) Before-User-Created auth hook.
-- --------------------------------------------------------------------
-- Postgres-function implementation of the Supabase "Before User
-- Created" hook. Signature + payload shape per
-- https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook:
--
--   payload: {
--     metadata: { uuid, time, name: 'before-user-created', ip_address },
--     user:     { email, app_metadata, user_metadata, ... auth.users shape }
--   }
--
-- Allow: return '{}'::jsonb. Reject: return an error object with
-- http_code. We reject with 403 and a deliberately generic message —
-- the response is visible to the client, so leaking "this email was
-- previously age-blocked" would betray the minimum-record stance.
--
-- Not SECURITY DEFINER: Supabase's hook docs explicitly recommend
-- against SECURITY DEFINER for auth hooks. supabase_auth_admin has
-- BYPASSRLS on this project, so a direct `select from
-- public.age_block_tombstones` works despite RLS being on with no
-- policies.
create function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_email    text;
  v_hash     text;
  v_blocked  boolean;
begin
  v_email := event -> 'user' ->> 'email';
  -- Nothing to enforce on an empty/missing email — let auth decide.
  if v_email is null or btrim(v_email) = '' then
    return '{}'::jsonb;
  end if;

  v_hash := encode(
    pg_catalog.sha256(lower(btrim(v_email))::bytea),
    'hex'
  );

  select true
    into v_blocked
    from public.age_block_tombstones
    where email_hash = v_hash
      and expires_at > now()
    limit 1;

  if v_blocked is true then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'message',   'Signup not permitted for this email.',
        'http_code', 403
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb)
  from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb)
  to supabase_auth_admin;

comment on function public.hook_before_user_created(jsonb) is
  'Supabase Before-User-Created auth hook. Rejects signup when the '
  'submitted email''s normalized hash '
  '(encode(sha256(lower(btrim(email))::bytea), ''hex'')) exists in '
  'public.age_block_tombstones with expires_at > now(). Returns the '
  'documented {error:{message,http_code}} envelope on reject and '
  '{} on allow. Enable in Dashboard → Authentication → Hooks → '
  'Before user created → Postgres → public.hook_before_user_created. '
  'Not SECURITY DEFINER; execute granted to supabase_auth_admin only.';

commit;
