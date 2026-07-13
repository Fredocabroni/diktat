-- Migration: persist users.tier_id in settlement (+ one-time backfill).
--
-- Bug: `apply_ap_drafts` (migration 20260420090013) updated current_ap but
-- never tier_id, and no trigger recomputed it — so tier_id sat at its default
-- (0) for everyone. Settlement read tier 0 for all users, so the ghost-earnings
-- gate never graduated and real payouts (tiers.payout_eligible, true only for
-- tier >= 3) never unlocked. Profile badges also showed Citizen forever.
--
-- Fix (schema-reviewed, Option A): recompute tier_id from the post-settlement
-- balance inside `apply_ap_drafts`, in the same UPDATE that writes current_ap,
-- under the same per-user FOR UPDATE lock. The band lookup queries public.tiers
-- (the seed's single source of truth) so it stays in lockstep with the engine's
-- tierFromAp. Also emits the tier crossing (before/after/changed) on each
-- applied result for a future celebration surface, and backfills existing rows.
--
-- This `create or replace` restates the 20260420090013 body VERBATIM except for
-- the tier additions (2 declares, 2 band lookups with null-guards immediately
-- before the users UPDATE, the tier_id set-clause, and 3 result-jsonb keys on
-- each of the applied / duplicate / user_not_found branches). The
-- is_practice column + ap_tx_practice_today_idx from 0013 are already applied
-- and are NOT restated here.
--
-- Down: reference-only (see foot). NOTE: the backfill is NOT reversible —
-- tier_id is derived state and self-heals on the next settlement, so there is
-- no meaningful "undo" for which rows were tier-0-by-bug vs. legitimately 0.

begin;

create or replace function public.apply_ap_drafts(p_drafts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft jsonb;
  v_user_id uuid;
  v_delta integer;
  v_ghost_usd_micros bigint;
  v_reason text;
  v_ref_type text;
  v_ref_id uuid;
  v_idempotency_key text;
  v_is_practice boolean;
  v_current_ap integer;
  v_balance_after integer;
  v_existing_row uuid;
  v_practice_today_total integer;
  v_capped_delta integer;
  v_tier_before smallint;
  v_tier_after smallint;
  v_results jsonb := '[]'::jsonb;
begin
  if p_drafts is null or jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'apply_ap_drafts: p_drafts must be a jsonb array';
  end if;

  for v_draft in select * from jsonb_array_elements(p_drafts) loop
    -- Extract fields. Missing optional fields default safely.
    v_user_id := (v_draft->>'user_id')::uuid;
    v_delta := (v_draft->>'delta')::integer;
    v_ghost_usd_micros := coalesce((v_draft->>'ghost_usd_micros')::bigint, 0::bigint);
    v_reason := v_draft->>'reason';
    v_ref_type := v_draft->>'ref_type';
    v_ref_id := nullif(v_draft->>'ref_id', '')::uuid;
    v_idempotency_key := v_draft->>'idempotency_key';
    v_is_practice := coalesce((v_draft->>'is_practice')::boolean, false);

    -- Idempotency check — short-circuit duplicates before doing any work.
    select id into v_existing_row
      from public.ap_transactions
      where idempotency_key = v_idempotency_key;

    if v_existing_row is not null then
      -- Return current balance so the caller has an accurate snapshot.
      -- A replay is NOT a crossing: tier_before/after are null and
      -- tier_changed is false by contract, so no celebration double-fires.
      select current_ap into v_current_ap from public.users where id = v_user_id;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'idempotency_key', v_idempotency_key,
        'applied', false,
        'balance_after', v_current_ap,
        'capped_delta', 0,
        'skipped_reason', 'duplicate',
        'tier_before', null,
        'tier_after', null,
        'tier_changed', false
      ));
      continue;
    end if;

    -- Lock the user row. Concurrent settles for the same user serialize here.
    select current_ap into v_current_ap
      from public.users
      where id = v_user_id
      for update;

    if v_current_ap is null then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'idempotency_key', v_idempotency_key,
        'applied', false,
        'balance_after', null,
        'capped_delta', 0,
        'skipped_reason', 'user_not_found',
        'tier_before', null,
        'tier_after', null,
        'tier_changed', false
      ));
      continue;
    end if;

    -- Practice 200/day cap. Only positive practice deltas count; losses
    -- and ghost credits pass through. UTC midnight rollover.
    v_capped_delta := v_delta;
    if v_is_practice and v_delta > 0 then
      select coalesce(sum(delta), 0) into v_practice_today_total
        from public.ap_transactions
        where user_id = v_user_id
          and is_practice = true
          and delta > 0
          and created_at >= date_trunc('day', (now() at time zone 'utc'));

      if v_practice_today_total + v_delta > 200 then
        v_capped_delta := greatest(0, 200 - v_practice_today_total);
      end if;
    end if;

    -- Compute balance, floored at 0 (also enforced by the column CHECK).
    v_balance_after := greatest(0, v_current_ap + v_capped_delta);

    -- Write the audit row first so the ledger is the source of truth.
    insert into public.ap_transactions (
      user_id,
      delta,
      balance_after,
      reason,
      ref_type,
      ref_id,
      idempotency_key,
      is_practice
    ) values (
      v_user_id,
      v_capped_delta,
      v_balance_after,
      v_reason,
      v_ref_type,
      v_ref_id,
      v_idempotency_key,
      v_is_practice
    );

    -- Resolve the tier bands for the locked before-balance and the resulting
    -- after-balance. Placed immediately before the users UPDATE (after the
    -- FOR UPDATE read) so both reflect the locked balance and cannot race a
    -- concurrent settle. Bands in public.tiers are contiguous + non-overlapping
    -- (seed 20260420090003) so each value matches exactly one row; ap_max is
    -- null only for the open-top Mythic band. A zero-row match would leave the
    -- target null and abort settlement on the not-null tier_id column, so guard
    -- explicitly and fail loud + localized instead.
    select id into v_tier_before
      from public.tiers
      where ap_min <= v_current_ap and (ap_max is null or v_current_ap <= ap_max);
    if v_tier_before is null then
      raise exception 'apply_ap_drafts: no tier band matches before-ap=%', v_current_ap;
    end if;

    select id into v_tier_after
      from public.tiers
      where ap_min <= v_balance_after and (ap_max is null or v_balance_after <= ap_max);
    if v_tier_after is null then
      raise exception 'apply_ap_drafts: no tier band matches after-ap=%', v_balance_after;
    end if;

    -- Update the live balance AND the derived tier, atomically under the lock.
    update public.users
      set current_ap = v_balance_after,
          tier_id = v_tier_after,
          updated_at = now()
      where id = v_user_id;

    -- Wallet ghost mint (winners at tiers 0–2 only — engine emits 0 otherwise).
    if v_ghost_usd_micros > 0 then
      update public.wallets
        set usdc_balance_micro = usdc_balance_micro + v_ghost_usd_micros,
            updated_at = now()
        where user_id = v_user_id;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'idempotency_key', v_idempotency_key,
      'applied', true,
      'balance_after', v_balance_after,
      'capped_delta', v_capped_delta,
      'skipped_reason', null,
      'tier_before', v_tier_before,
      'tier_after', v_tier_after,
      'tier_changed', (v_tier_after is distinct from v_tier_before)
    ));
  end loop;

  return v_results;
end;
$$;

-- EXECUTE stays service_role only (create or replace preserves privileges;
-- restated here for clarity + idempotency). See 20260420090013 for rationale.
revoke all on function public.apply_ap_drafts(jsonb) from public;
grant execute on function public.apply_ap_drafts(jsonb) to service_role;

-- One-time backfill: correct every existing users.tier_id to its AP band.
-- Idempotent — `is distinct from` makes re-runs no-ops and only touches rows
-- whose tier_id is wrong. current_ap is not-null / >= 0 (mig 0002), so the band
-- predicate always matches exactly one tiers row; the set target is a real
-- public.tiers.id so the FK holds. Fires users_set_updated_at (harmless).
update public.users u
  set tier_id = t.id
  from public.tiers t
  where t.ap_min <= u.current_ap
    and (t.ap_max is null or u.current_ap <= t.ap_max)
    and u.tier_id is distinct from t.id;

commit;

-- Down (reference, not auto-run):
--   -- Restore the pre-tier function body by re-applying 20260420090013's
--   -- `create or replace function public.apply_ap_drafts(jsonb) ...` verbatim.
--   -- The backfill is NOT reversible: tier_id is derived state and self-heals
--   -- on the next settlement, so there is no correct row-level undo.
