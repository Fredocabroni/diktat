-- Migration: age-block tombstone hardening.
--
-- Pre-flip hardening for migration 20261115000000. Closes three gaps
-- that block flipping public.data_minimization_sweep from dry-run to
-- live:
--
--   (a) Plain SHA-256(email) is not keyed. Anyone with a user's email
--       can recompute the tombstone hash. We replace it with HMAC-
--       SHA256 keyed by a server-side pepper stored in Supabase Vault
--       under the name 'age_block_pepper'. Both the sweep and the hook
--       go through ONE shared SECURITY DEFINER helper
--       (public._age_block_hash) so there is exactly one hash site.
--
--   (b) X / email-less OAuth accounts have no tombstone key today —
--       email_hash is the only column. We add
--       public.age_block_identity_tombstones keyed by the HMAC of
--       '<provider>:<provider_user_id>'. The LIVE sweep reads
--       auth.identities for each victim and writes one row per
--       identity; the hook iterates event->'user'->'identities' and
--       checks each identity_hash. (The identities[] shape at
--       pre-create is undocumented in the Supabase docs; the hook
--       code is forward-compatible with Supabase populating this
--       array, and the sweep-written row is the real line of defense
--       on repeat-attempt purges either way.)
--
--   (c) supabase_auth_admin currently holds GRANT ALL on
--       age_block_tombstones. It only needs SELECT (the hook reads;
--       the sweep writes via SECURITY DEFINER owner-chain, not as
--       auth_admin). We revoke and re-grant SELECT only, and apply
--       the same posture to the new identity table.
--
-- Fail-mode asymmetry:
--
--   * Hook (public.hook_before_user_created): FAILS OPEN on any
--     error — missing pepper, Vault outage, bad payload shape. Logs
--     a warning and returns '{}'. The hook must never block a legit
--     signup because of our bug.
--
--   * Live sweep: FAILS CLOSED on missing pepper. The per-victim
--     hash call raises, the transaction aborts, no deletes occur.
--
--   * Dry-run sweep: unaffected by pepper state — the dry-run branch
--     never calls _age_block_hash. Dry-run output will not expose the
--     hash values that a live run would write; operators should not
--     expect hash parity between modes.
--
-- Operator step BEFORE this migration is applied to prod: create the
-- pepper via
--
--   select vault.create_secret(
--     encode(extensions.gen_random_bytes(32), 'hex'),
--     'age_block_pepper',
--     'HMAC pepper for public._age_block_hash (age-block tombstones)'
--   );
--
-- Verify with
--   select name, created_at from vault.secrets where name = 'age_block_pepper';
--
-- Up:
--   create or replace public._age_block_hash(text);
--   alter table age_block_tombstones add key_version smallint default 1;
--   create table age_block_identity_tombstones (identity_hash primary key, ...);
--   revoke all; grant select only to supabase_auth_admin on both tables;
--   create or replace public.data_minimization_sweep(boolean) with
--     identity-tombstone writes + HMAC-via-helper on live path;
--   create or replace public.hook_before_user_created(jsonb) with
--     identity path + fail-open exception handler.
--
-- Down:
--   create or replace public.hook_before_user_created back to the
--     20261115000000 body;
--   create or replace public.data_minimization_sweep back to the
--     20261115000000 body;
--   restore grant all on age_block_tombstones to supabase_auth_admin;
--   drop table public.age_block_identity_tombstones;
--   alter table age_block_tombstones drop column key_version;
--   drop function public._age_block_hash(text);

begin;

-- --------------------------------------------------------------------
-- (1) Shared, keyed hash helper.
-- --------------------------------------------------------------------
-- SECURITY DEFINER so it can read vault.decrypted_secrets regardless
-- of caller role. search_path='' forces fully-qualified refs.
--
-- Returns null when input is null/blank — callers must treat null as
-- "nothing to enforce" and skip the lookup.
--
-- Raises when the pepper is missing or empty. Raising is intentional:
-- the live sweep lets the raise propagate (abort the live transaction
-- → fail-closed on bad config), while the hook catches it via a
-- WHEN OTHERS block → fail-open on signup.
create or replace function public._age_block_hash(p_input text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pepper text;
begin
  if p_input is null or btrim(p_input) = '' then
    return null;
  end if;

  select decrypted_secret into v_pepper
    from vault.decrypted_secrets
    where name = 'age_block_pepper'
    limit 1;

  if v_pepper is null or length(v_pepper) = 0 then
    raise exception 'age_block_pepper vault secret missing or empty'
      using errcode = 'P0001';
  end if;

  return encode(
    extensions.hmac(lower(btrim(p_input))::bytea, v_pepper::bytea, 'sha256'),
    'hex'
  );
end;
$$;

revoke execute on function public._age_block_hash(text)
  from public, anon, authenticated;
grant  execute on function public._age_block_hash(text)
  to supabase_auth_admin;

comment on function public._age_block_hash(text) is
  'HMAC-SHA256 of the lower+btrim''d input, keyed by the '
  '"age_block_pepper" secret in Supabase Vault. Returns hex. '
  'Null-safe on blank input (returns null). Raises when the pepper is '
  'missing — live sweep propagates (fail-closed), hook catches and '
  'fails open. Shared by both hash sites: the data_minimization_sweep '
  'tombstone writer and the hook_before_user_created lookup. '
  'SECURITY DEFINER, search_path='''', executable by '
  'supabase_auth_admin only (sweep calls through its own owner-chain).';

-- --------------------------------------------------------------------
-- (2) Tombstone table changes.
-- --------------------------------------------------------------------
-- key_version lets us rotate the pepper later: rows written under
-- pepper v1 keep key_version=1 and age out via expires_at while new
-- writes land at v2. No schema change needed at rotation time.
alter table public.age_block_tombstones
  add column if not exists key_version smallint not null default 1;

comment on column public.age_block_tombstones.key_version is
  'Pepper version used to compute email_hash. Default 1. Bump the '
  'column default when rotating public._age_block_hash''s pepper; '
  'rows at older versions age out via expires_at.';

-- Identity tombstones. Separate table because the key is distinct
-- from email_hash and because keeping two single-column PKs is
-- simpler than making email_hash nullable on the existing table.
create table public.age_block_identity_tombstones (
  identity_hash text        primary key,
  key_version   smallint    not null default 1,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '1 year'
);

alter table public.age_block_identity_tombstones enable row level security;

create index age_block_identity_tombstones_expires_at_idx
  on public.age_block_identity_tombstones (expires_at);

comment on table public.age_block_identity_tombstones is
  'Age-block enforcement for OAuth identities (X / Twitter, Google, '
  'etc.). identity_hash = public._age_block_hash(provider || '''':'''' '
  '|| provider_user_id). Written by public.data_minimization_sweep '
  'on the LIVE age-blocked purge — one row per auth.identities row '
  'belonging to the victim. Checked by public.hook_before_user_created '
  'against event->''user''->''identities''. RLS on, no policies; '
  'supabase_auth_admin has SELECT only; service_role bypasses RLS.';

-- --------------------------------------------------------------------
-- (3) Least-privilege re-grant on both tombstone tables.
-- --------------------------------------------------------------------
-- The hook needs SELECT; nothing user-facing needs anything else.
-- The sweep writes via SECURITY DEFINER as function owner (postgres),
-- not through supabase_auth_admin. Over-granting ALL on PR #295 was
-- the only reason auth_admin could ever touch INSERT/UPDATE/DELETE on
-- the table; we close that now.
revoke all on public.age_block_tombstones          from supabase_auth_admin;
revoke all on public.age_block_identity_tombstones from supabase_auth_admin;

grant  select on public.age_block_tombstones          to supabase_auth_admin;
grant  select on public.age_block_identity_tombstones to supabase_auth_admin;

-- --------------------------------------------------------------------
-- (4) data_minimization_sweep: HMAC via helper + identity tombstones.
-- --------------------------------------------------------------------
-- Deltas vs. the 20261115000000 body:
--
--   * Top-of-function cleanup now scans both tombstone tables; the
--     returned tombstones_expired counts the sum (preserving the
--     existing return-key semantics "expired tombstones removed this
--     tick").
--
--   * In the LIVE age-blocked loop:
--       - Email hash: public._age_block_hash(v_email) instead of
--         inline sha256(). Null-safe; a null hash skips the upsert.
--       - After the email upsert, read auth.identities for the
--         victim and upsert into age_block_identity_tombstones.
--
--   * Return shape gains identity_tombstones_written. The
--     workers handler defaults missing keys to 0 for legacy
--     compatibility.
--
-- Pepper state:
--   * Dry-run never calls _age_block_hash — pepper state is
--     irrelevant.
--   * Live run calls _age_block_hash in both loops. A missing pepper
--     raises; the raise propagates; the transaction aborts without
--     deleting anything.
create or replace function public.data_minimization_sweep(p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch_date                   date     := date '2026-10-21';
  v_pre_launch_window             interval := interval '30 days';
  v_block_window                  interval := interval '7 days';
  v_tombstone_ttl                 interval := interval '1 year';
  v_id_cap                        int      := 500;
  v_blocked_count                 int;
  v_pre_launch_count              int;
  v_deleted_blocked               int := 0;
  v_deleted_pre_launch            int := 0;
  v_tombstones_written            int := 0;
  v_tombstones_expired            int := 0;
  v_identity_tombstones_written   int := 0;
  v_identity_tombstones_expired   int := 0;
  v_blocked_ids                   jsonb := '[]'::jsonb;
  v_pre_launch_ids                jsonb := '[]'::jsonb;
  v_id                            uuid;
  v_email                         text;
  v_hash                          text;
  v_id_hash                       text;
  v_identity_row                  record;
  v_expired_emails                int;
  v_expired_identities            int;
begin
  -- (0) Expired-tombstone cleanup — both tables, every tick.
  delete from public.age_block_tombstones
   where expires_at <= now();
  get diagnostics v_expired_emails = row_count;

  delete from public.age_block_identity_tombstones
   where expires_at <= now();
  get diagnostics v_expired_identities = row_count;

  v_tombstones_expired := v_expired_emails;
  v_identity_tombstones_expired := v_expired_identities;

  -- Candidate counts (unchanged).
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
    -- Dry-run: candidate UUIDs, no hashes, no writes. Pepper absent
    -- is fine on this path.
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
    -- (1) Age-blocked purge.
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
      -- Resolve email + hash it via the shared helper.
      select au.email
        into v_email
        from auth.users au
       where au.id = v_id;

      v_hash := public._age_block_hash(v_email);
      if v_hash is not null then
        insert into public.age_block_tombstones (email_hash, expires_at)
        values (v_hash, now() + v_tombstone_ttl)
        on conflict (email_hash) do update
          set expires_at = excluded.expires_at;
        v_tombstones_written := v_tombstones_written + 1;
      end if;

      -- Identity tombstones: one row per auth.identities for this user.
      for v_identity_row in
        select ai.provider, ai.provider_id
          from auth.identities ai
          where ai.user_id = v_id
      loop
        if v_identity_row.provider is not null
           and v_identity_row.provider_id is not null then
          v_id_hash := public._age_block_hash(
            v_identity_row.provider || ':' || v_identity_row.provider_id
          );
          if v_id_hash is not null then
            insert into public.age_block_identity_tombstones (identity_hash, expires_at)
            values (v_id_hash, now() + v_tombstone_ttl)
            on conflict (identity_hash) do update
              set expires_at = excluded.expires_at;
            v_identity_tombstones_written :=
              v_identity_tombstones_written + 1;
          end if;
        end if;
      end loop;

      perform public._scrub_user_ledger_keys(v_id);
      delete from auth.users where id = v_id;
      v_deleted_blocked := v_deleted_blocked + 1;
      if v_deleted_blocked <= v_id_cap then
        v_blocked_ids := v_blocked_ids || to_jsonb(v_id);
      end if;
    end loop;

    -- (2) Pre-launch orphan purge: no tombstone writes (unchanged).
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
    'dry_run',                     p_dry_run,
    'blocked_candidates',          v_blocked_count,
    'pre_launch_candidates',       v_pre_launch_count,
    'deleted_blocked',             v_deleted_blocked,
    'deleted_pre_launch',          v_deleted_pre_launch,
    'tombstones_written',          v_tombstones_written,
    'tombstones_expired',          v_tombstones_expired,
    'identity_tombstones_written', v_identity_tombstones_written,
    'identity_tombstones_expired', v_identity_tombstones_expired,
    'blocked_candidate_ids',       v_blocked_ids,
    'pre_launch_candidate_ids',    v_pre_launch_ids,
    'launch_date',                 to_char(v_launch_date, 'YYYY-MM-DD'),
    'swept_at',                    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

revoke all on function public.data_minimization_sweep(boolean)
  from public, anon, authenticated;
grant execute on function public.data_minimization_sweep(boolean) to service_role;

comment on function public.data_minimization_sweep(boolean) is
  'Pre-launch data minimization. Deletes age-blocked humans >7 days '
  'and pre-launch orphan humans >30 days post-launch. Bots and '
  'public.sweep_protected_users rows excluded. Dry-run returns '
  'candidate UUIDs (capped 500) under blocked_candidate_ids / '
  'pre_launch_candidate_ids and performs no writes. Live run scrubs '
  'idempotency_keys via public._scrub_user_ledger_keys() per victim '
  'BEFORE the auth.users DELETE cascades; writes an HMAC-SHA256 '
  'email-hash tombstone into public.age_block_tombstones AND one '
  'row per auth.identities into public.age_block_identity_tombstones '
  'for the age-blocked branch only (not pre-launch). Both tables '
  'drop expired rows at the top of every tick (dry-run included). '
  'Hash via public._age_block_hash — a missing Vault pepper raises '
  'on live and propagates (fail-closed); dry-run never calls the '
  'helper. service_role only.';

-- --------------------------------------------------------------------
-- (5) hook_before_user_created: single hash site + fail-open.
-- --------------------------------------------------------------------
-- Checks the email path first, then iterates the identities[] array.
-- Entire body is wrapped in a WHEN OTHERS catch so that any error —
-- missing pepper, Vault outage, bad payload shape, hash function
-- dropped — logs a warning and returns '{}'. NEVER blocks a legit
-- signup because of our bug.
--
-- Not SECURITY DEFINER (per Supabase hook contract).
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user         jsonb;
  v_email        text;
  v_hash         text;
  v_blocked      boolean;
  v_identity     jsonb;
  v_provider     text;
  v_provider_id  text;
begin
  v_user := event -> 'user';

  -- (a) Email path.
  v_email := v_user ->> 'email';
  if v_email is not null and btrim(v_email) <> '' then
    v_hash := public._age_block_hash(v_email);
    if v_hash is not null then
      v_blocked := null;
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
    end if;
  end if;

  -- (b) Identity path. Iterate event->'user'->'identities'[]. Shape at
  -- pre-create is undocumented in the Supabase docs; when the array
  -- is empty or missing this loop is a no-op, and the sweep-written
  -- identity tombstone remains the line of defense on repeat-attempt
  -- purges. This body is forward-compatible with Supabase populating
  -- the array without a code change.
  for v_identity in
    select *
      from jsonb_array_elements(
        coalesce(v_user -> 'identities', '[]'::jsonb)
      )
  loop
    v_provider    := v_identity ->> 'provider';
    v_provider_id := coalesce(
      v_identity ->> 'provider_id',
      v_identity ->> 'id'
    );
    if v_provider is not null and v_provider_id is not null
       and btrim(v_provider) <> '' and btrim(v_provider_id) <> '' then
      v_hash := public._age_block_hash(v_provider || ':' || v_provider_id);
      if v_hash is not null then
        v_blocked := null;
        select true
          into v_blocked
          from public.age_block_identity_tombstones
          where identity_hash = v_hash
            and expires_at > now()
          limit 1;
        if v_blocked is true then
          return jsonb_build_object(
            'error', jsonb_build_object(
              'message',   'Signup not permitted for this account.',
              'http_code', 403
            )
          );
        end if;
      end if;
    end if;
  end loop;

  return '{}'::jsonb;

exception when others then
  -- Fail-open guard. Covers: missing pepper (P0001 from
  -- _age_block_hash), Vault outage, hash function dropped, bad
  -- payload shape, anything else. Operators monitor the Postgres
  -- warning stream for soft-fails.
  raise warning 'age_block hook soft-fail: % (sqlstate %)', SQLERRM, SQLSTATE;
  return '{}'::jsonb;
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb)
  from public, anon, authenticated;
grant  execute on function public.hook_before_user_created(jsonb)
  to supabase_auth_admin;

comment on function public.hook_before_user_created(jsonb) is
  'Supabase Before-User-Created auth hook. Rejects signup when the '
  'submitted email HMAC exists in public.age_block_tombstones with '
  'expires_at > now(), OR when any identity in event->''user''->'
  '''identities''[] hashes into public.age_block_identity_tombstones. '
  'Hash via public._age_block_hash (HMAC-SHA256 keyed by Vault secret '
  '"age_block_pepper"). Returns the documented '
  '{error:{message,http_code}} envelope on reject and {} on allow. '
  'FAILS OPEN on any error (missing pepper, Vault outage, hash '
  'function dropped): returns {} and emits a warning. '
  'Not SECURITY DEFINER; execute granted to supabase_auth_admin only.';

commit;
