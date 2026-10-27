-- Migration: pre-flip hardening of data_minimization_sweep.
--
-- PR #292 shipped `data_minimization_sweep(boolean)` with DRY RUN ON as a
-- pre-launch audit path. Before we ever flip the pg_cron payload to
-- `{dry_run: false}` this migration closes four gaps:
--
--   1. Shared idempotency-key UUID scrub. The scrub block inside
--      `delete_my_account()` (migration 20261110000000) is extracted into
--      an internal SECURITY DEFINER helper so a live sweep run anonymizes
--      every victim's `ap_transactions.idempotency_key` BEFORE the
--      auth.users DELETE lands. Without this the FK's ON DELETE SET NULL
--      nulls the user_id but leaves `signup_grant:<uuid>` strings
--      embedded forever in the ledger — defeating the whole point of the
--      scrub `delete_my_account` already does for the self-serve path.
--   2. Operator allowlist. New table `public.sweep_protected_users` —
--      service_role only, no end-user visibility — whose rows are
--      excluded from BOTH sweep branches in BOTH counts AND deletes.
--      Lets the operator park a known-test or compliance-hold account
--      without yanking the whole pg_cron entry.
--   3. Candidate UUIDs in output. Dry-run now returns
--      `blocked_candidate_ids` + `pre_launch_candidate_ids` jsonb arrays
--      (capped 500 each, ordered by created_at) so the operator can
--      audit what a live run would delete BEFORE flipping the flag.
--      Live-run returns the same keys populated with UUIDs that were
--      actually deleted (same 500 cap).
--   4. `extensions.gen_random_uuid()` schema-qualified. The function
--      body runs with `search_path = ''`; a bare `gen_random_uuid()`
--      only resolves because `pg_catalog` is implicit, but pgcrypto
--      lives in `extensions` on this project. Qualify it.
--
-- Shipping posture: UNCHANGED. pg_cron entry still passes
-- `{dry_run: true}`. This migration does not flip anything live.
--
-- Up:
--   create function public._scrub_user_ledger_keys(uuid) ... (owner only).
--   create or replace function public.delete_my_account() to delegate to it.
--   create table public.sweep_protected_users; RLS on; no policies.
--   create or replace function public.data_minimization_sweep(boolean)
--     with allowlist exclusion + candidate arrays + scrub-per-victim.
--
-- Down:
--   drop function public.data_minimization_sweep(boolean);
--   restore delete_my_account() from 20261110000000.
--   drop table public.sweep_protected_users;
--   drop function public._scrub_user_ledger_keys(uuid);

begin;

-- --------------------------------------------------------------------
-- (1) Shared idempotency-key UUID scrub helper.
-- --------------------------------------------------------------------
-- Owner-only, no grants to any role. Reachable from other SECURITY
-- DEFINER functions created by the same owner (which run with the
-- owner's privileges and can call it). search_path = '' + fully
-- schema-qualified identifiers so a hostile session setting cannot
-- shadow public.ap_transactions or `extensions.gen_random_uuid`.
--
-- The scrub rewrites every substring match of `p_user_id` inside
-- `idempotency_key` to `deleted:<fresh uuid>`. The UNIQUE index on
-- idempotency_key stays satisfied because `extensions.gen_random_uuid()`
-- is VOLATILE — one distinct replacement per row.
create function public._scrub_user_ledger_keys(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scrubbed int;
begin
  update public.ap_transactions
     set idempotency_key = replace(
           idempotency_key,
           p_user_id::text,
           'deleted:' || extensions.gen_random_uuid()::text
         )
   where user_id = p_user_id
      or idempotency_key like '%' || p_user_id::text || '%';
  get diagnostics v_scrubbed = row_count;
  return v_scrubbed;
end;
$$;

-- Belt-and-braces: revoke from service_role too so the "owner-only"
-- intent is enforced by explicit deny, not just absence-of-grant.
-- The owner (postgres) retains its implicit EXECUTE on its own
-- functions, so the SECURITY DEFINER owner-chain from
-- delete_my_account / data_minimization_sweep still works.
revoke all on function public._scrub_user_ledger_keys(uuid)
  from public, anon, authenticated, service_role;

comment on function public._scrub_user_ledger_keys(uuid) is
  'Internal: anonymizes ap_transactions.idempotency_key for the given '
  'user — rewrites every substring match of the UUID to '
  '''deleted:<fresh uuid>''. Owner-only, no grants. Called by '
  'public.delete_my_account() and public.data_minimization_sweep() '
  '(both SECURITY DEFINER, same owner). search_path='''' + schema-'
  'qualified extensions.gen_random_uuid().';

-- --------------------------------------------------------------------
-- Rewire delete_my_account() to call the helper.
-- --------------------------------------------------------------------
-- Behaviour is byte-identical to migration 20261110000000: same gates,
-- same P0001 raise codes, same return shape. The existing
-- `account_deletion_ledger.test.sql` suite (D1..D9) must stay green.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id       uuid;
  v_last_sign_in  timestamptz;
  v_in_live       int;
  v_scrubbed      int;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'delete_my_account: unauthenticated'
      using errcode = '28000';
  end if;

  -- (a) Recent-auth window: last_sign_in_at within the last 10 minutes.
  select u.last_sign_in_at
    into v_last_sign_in
    from auth.users u
    where u.id = v_user_id;
  if v_last_sign_in is null
     or v_last_sign_in < now() - interval '10 minutes' then
    raise exception 'delete_my_account: recent_auth_required'
      using errcode = 'P0001';
  end if;

  -- (b) No delete mid-battle.
  select count(*)
    into v_in_live
    from public.battle_participants bp
    join public.battles b on b.id = bp.battle_id
    where bp.user_id = v_user_id
      and b.status = 'live';
  if v_in_live > 0 then
    raise exception 'delete_my_account: in_live_battle'
      using errcode = 'P0001';
  end if;

  -- (c) Idempotency-key UUID scrub via the shared helper.
  v_scrubbed := public._scrub_user_ledger_keys(v_user_id);

  return jsonb_build_object(
    'ok', true,
    'scrubbed', v_scrubbed
  );
end;
$$;

-- --------------------------------------------------------------------
-- (2) Operator allowlist.
-- --------------------------------------------------------------------
-- RLS on, no policies. service_role bypasses RLS by default — same
-- pattern as public.reports (migration 20261112000000). authenticated
-- and anon have ZERO visibility to this table on direct PostgREST.
--
-- ON DELETE CASCADE on the FK: if the operator's protected account is
-- itself deleted some other way (e.g. a manual service-role DELETE),
-- the allowlist row goes with it. The sweep already excludes any
-- account the operator hasn't put here, so a stale allowlist row is
-- harmless, but keeping the FK honest costs nothing.
create table public.sweep_protected_users (
  user_id    uuid primary key
             references public.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.sweep_protected_users enable row level security;
revoke all on public.sweep_protected_users from public, anon, authenticated;

comment on table public.sweep_protected_users is
  'Operator allowlist. user_ids here are EXCLUDED from '
  'public.data_minimization_sweep in both the age-blocked and pre-'
  'launch branches, in counts AND deletes. RLS on, no policies — '
  'service_role only (bypasses RLS). authenticated and anon have no '
  'read or write path.';

-- --------------------------------------------------------------------
-- (3) Rewrite data_minimization_sweep with allowlist + candidate IDs +
--     per-victim scrub.
-- --------------------------------------------------------------------
-- Row-at-a-time looping is the right shape here:
--   * The per-victim scrub needs the user_id scalar.
--   * Expected sweep volume is tiny (pre-launch orphan count ≤ a
--     handful; age-blocked flow is pre-launch so also small).
--   * The scrub happens BEFORE the auth.users DELETE so the ON DELETE
--     SET NULL FK on ap_transactions.user_id doesn't nuke the
--     `user_id = p_user_id` branch of the scrub's OR filter mid-pass.
create or replace function public.data_minimization_sweep(p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch_date        date := date '2026-10-21';
  v_pre_launch_window  interval := interval '30 days';
  v_block_window       interval := interval '7 days';
  v_id_cap             int := 500;
  v_blocked_count      int;
  v_pre_launch_count   int;
  v_deleted_blocked    int := 0;
  v_deleted_pre_launch int := 0;
  v_blocked_ids        jsonb := '[]'::jsonb;
  v_pre_launch_ids     jsonb := '[]'::jsonb;
  v_id                 uuid;
begin
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
    -- created_at so the operator can audit what a live run would
    -- delete. No deletes, no scrubs.
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
    -- (1) Age-blocked purge. Scrub each victim's idempotency_keys
    -- first (while public.users still exists), THEN delete from
    -- auth.users which cascades through public.users and nulls the
    -- ap_transactions.user_id. Loop by created_at ascending for a
    -- stable, auditable order.
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
      perform public._scrub_user_ledger_keys(v_id);
      delete from auth.users where id = v_id;
      v_deleted_blocked := v_deleted_blocked + 1;
      if v_deleted_blocked <= v_id_cap then
        v_blocked_ids := v_blocked_ids || to_jsonb(v_id);
      end if;
    end loop;

    -- (2) Pre-launch orphan purge. Same shape.
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
    'dry_run',                 p_dry_run,
    'blocked_candidates',      v_blocked_count,
    'pre_launch_candidates',   v_pre_launch_count,
    'deleted_blocked',         v_deleted_blocked,
    'deleted_pre_launch',      v_deleted_pre_launch,
    'blocked_candidate_ids',   v_blocked_ids,
    'pre_launch_candidate_ids', v_pre_launch_ids,
    'launch_date',             to_char(v_launch_date, 'YYYY-MM-DD'),
    'swept_at',                to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- SECURITY posture is unchanged: service_role only. create or replace
-- preserves the existing grant, but belt-and-braces re-apply.
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
  'DELETE cascades, so ap_transactions keeps no residual UUIDs. '
  'service_role only.';

commit;
