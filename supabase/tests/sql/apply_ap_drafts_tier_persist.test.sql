-- Behavioral test: apply_ap_drafts persists tier_id + emits the tier crossing
-- (migration 20260713120000_persist_tier_id_in_settlement).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
-- Connection is the postgres superuser → owns + may EXECUTE the SECURITY DEFINER
-- function. Proves the recompute at the DB layer, independent of the tRPC path
-- and the mocked API Vitest suite (which cannot execute the SQL).
--
-- Fixture user is created the canonical way: insert into auth.users and let the
-- handle_new_user() SECURITY DEFINER trigger auto-provision public.users
-- (current_ap default 100, tier_id default 0) / wallets / streaks / the signup
-- ap_transactions row. We then set current_ap = 749 (Partisan / tier 2) as the
-- pre-state; tier_id stays 0 (the exact stagnation bug this migration fixes).

begin;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'tier@test.local', now(), now());

-- Pre-state: 749 AP = top of Partisan (tier 2). tier_id is left at its stale
-- default (0) — direct current_ap writes do NOT recompute it (that is the bug).
update public.users set current_ap = 749 where id = 'a1111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- T1: apply +1 AP → 750 crosses Partisan(2) → Operative(3). Assert the applied
-- result carries the crossing, tier_id is PERSISTED, and payouts unlock at t3.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid uuid := 'a1111111-1111-1111-1111-111111111111';
  r jsonb;
  e jsonb;
  t_id smallint;
  ap integer;
  payout boolean;
begin
  r := public.apply_ap_drafts(jsonb_build_array(jsonb_build_object(
    'user_id', v_uid::text,
    'delta', 1,
    'reason', 'battle_win',
    'ref_type', 'battle',
    'ref_id', '00000000-0000-0000-0000-0000000000bb',
    'idempotency_key', 'test:tier-cross:1',
    'is_practice', false
  )));
  e := r->0;

  if (e->>'applied')::boolean is not true then raise exception 'T1 FAIL applied != true: %', e; end if;
  if (e->>'balance_after')::int <> 750 then raise exception 'T1 FAIL balance_after != 750: %', e; end if;
  if (e->>'tier_before')::int <> 2 then raise exception 'T1 FAIL tier_before != 2: %', e; end if;
  if (e->>'tier_after')::int <> 3 then raise exception 'T1 FAIL tier_after != 3: %', e; end if;
  if (e->>'tier_changed')::boolean is not true then raise exception 'T1 FAIL tier_changed != true: %', e; end if;

  -- Persisted state — the whole point of the migration.
  select tier_id, current_ap into t_id, ap from public.users where id = v_uid;
  if t_id <> 3 then raise exception 'T1 FAIL persisted tier_id=% (want 3)', t_id; end if;
  if ap <> 750 then raise exception 'T1 FAIL persisted current_ap=% (want 750)', ap; end if;

  -- Economic unlock: payouts are eligible at tier 3, not at tier 2.
  select payout_eligible into payout from public.tiers where id = 3;
  if payout is not true then raise exception 'T1 FAIL tier 3 payout_eligible=% (want true)', payout; end if;
  select payout_eligible into payout from public.tiers where id = 2;
  if payout is not false then raise exception 'T1 FAIL tier 2 payout_eligible=% (want false)', payout; end if;

  raise notice 'T1 PASS: 749->750 crossed t2->t3, tier_id persisted, payouts unlock at t3';
end $$;

-- ---------------------------------------------------------------------------
-- T2: replay the SAME idempotency_key → duplicate short-circuit. Assert NO
-- crossing (tier_changed=false, tier_before/after null) and NO double-apply.
-- This is the resume/no-double-fire guarantee.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid uuid := 'a1111111-1111-1111-1111-111111111111';
  r jsonb;
  e jsonb;
  t_id smallint;
  ap integer;
begin
  r := public.apply_ap_drafts(jsonb_build_array(jsonb_build_object(
    'user_id', v_uid::text,
    'delta', 1,
    'reason', 'battle_win',
    'ref_type', 'battle',
    'ref_id', '00000000-0000-0000-0000-0000000000bb',
    'idempotency_key', 'test:tier-cross:1',
    'is_practice', false
  )));
  e := r->0;

  if (e->>'applied')::boolean is not false then raise exception 'T2 FAIL applied != false: %', e; end if;
  if e->>'skipped_reason' <> 'duplicate' then raise exception 'T2 FAIL skipped_reason != duplicate: %', e; end if;
  if (e->>'tier_changed')::boolean is not false then raise exception 'T2 FAIL tier_changed != false: %', e; end if;
  if e->>'tier_before' is not null then raise exception 'T2 FAIL tier_before not null: %', e; end if;
  if e->>'tier_after' is not null then raise exception 'T2 FAIL tier_after not null: %', e; end if;

  -- No double-apply: tier_id and current_ap unchanged from T1.
  select tier_id, current_ap into t_id, ap from public.users where id = v_uid;
  if t_id <> 3 then raise exception 'T2 FAIL tier_id changed on replay=% (want 3)', t_id; end if;
  if ap <> 750 then raise exception 'T2 FAIL current_ap changed on replay=% (want 750)', ap; end if;

  raise notice 'T2 PASS: replay is a no-op — no crossing (tier_changed=false), tier_id unchanged';
end $$;

rollback;
\echo 'ALL ASSERTIONS PASSED'
