-- Migration: ap_transactions.is_practice + apply_ap_drafts(jsonb) SQL function
-- Up:   adds is_practice flag to public.ap_transactions; defines a SECURITY
--       DEFINER function that atomically applies a batch of AP drafts:
--       idempotency check → user row lock → practice 200/day cap →
--       ap_transactions insert → users.current_ap update → wallet ghost
--       mint. All inside the implicit transaction the function runs in.
-- Down: drop the function and the column. Reversible.
--
-- DESIGN
-- ------
-- This function is the AP economy's atomic-write boundary. Before it
-- existed, the @diktat/ap-engine adapter did select-then-insert from the
-- JS side; concurrent settles for the same user could interleave and
-- produce a wrong current_ap. This function takes the row lock and does
-- all the writes as one unit, so two simultaneous battles for the same
-- user serialize cleanly.
--
-- INPUT (p_drafts) is a JSON array. Each element:
--   {
--     "user_id": uuid,
--     "delta": integer,                 -- signed
--     "ghost_usd_micros": bigint,       -- non-negative (winners only)
--     "reason": ap_reason,              -- existing CHECK constraint
--     "ref_type": text|null,
--     "ref_id": uuid|null,
--     "idempotency_key": text,
--     "is_practice": boolean            -- defaults to false if absent
--   }
--
-- OUTPUT is a JSON array, one entry per input draft, in the same order:
--   {
--     "idempotency_key": text,
--     "applied": boolean,               -- true if a new row was written
--     "balance_after": integer|null,    -- live balance after the apply
--     "capped_delta": integer,          -- delta actually credited (may
--                                       --  differ from input.delta when
--                                       --  the practice cap kicks in)
--     "skipped_reason": text|null       -- "duplicate" or "user_not_found"
--   }
--
-- PRACTICE 200/DAY CAP
-- --------------------
-- When is_practice=true AND delta>0, the function sums today's positive
-- practice deltas for the user and caps the new credit so total ≤ 200
-- per UTC day. The ledger row is still written (with the capped delta —
-- which may be 0) so analytics can see "practice win recorded, AP
-- protected by daily cap".
--
-- IDEMPOTENCY
-- -----------
-- If a row with the input idempotency_key already exists, the function
-- skips the apply and returns applied=false with the existing user's
-- live balance. The ap_transactions.idempotency_key UNIQUE index gives
-- us the lookup.
--
-- ATOMICITY
-- ---------
-- Each draft locks `users.id FOR UPDATE` before reading current_ap.
-- The whole function runs inside a single transaction (Postgres
-- semantics for plpgsql), so concurrent settles serialize on the
-- per-user row lock.

begin;

-- 1) New column on ap_transactions. Default false so existing rows
--    backfill correctly. RLS already enforces self-only SELECT (from
--    migration 0002), and INSERT is service-role only by design.
alter table public.ap_transactions
  add column if not exists is_practice boolean not null default false;

-- Helpful index for the practice-cap sum: queries look like
--   where user_id = $1 and is_practice = true and delta > 0
--     and created_at >= date_trunc('day', now() at time zone 'utc')
-- The existing (user_id, created_at desc) index already serves the
-- date filter; this partial index narrows the cardinality further so
-- the cap-sum is cheap even at high transaction volume.
create index if not exists ap_tx_practice_today_idx
  on public.ap_transactions (user_id, created_at desc)
  where is_practice = true and delta > 0;

-- 2) The function itself.
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
      select current_ap into v_current_ap from public.users where id = v_user_id;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'idempotency_key', v_idempotency_key,
        'applied', false,
        'balance_after', v_current_ap,
        'capped_delta', 0,
        'skipped_reason', 'duplicate'
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
        'skipped_reason', 'user_not_found'
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

    -- Update the live balance.
    update public.users
      set current_ap = v_balance_after,
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
      'skipped_reason', null
    ));
  end loop;

  return v_results;
end;
$$;

-- Restrict EXECUTE to service_role only. The function is SECURITY DEFINER
-- and bypasses RLS by design — granting `authenticated` here would let any
-- signed-in user call the function via PostgREST RPC with hand-crafted
-- drafts (e.g. `user_id = self, delta = 1_000_000`) and credit themselves
-- arbitrary AP. Settlement is server-driven; the only legitimate caller
-- is the API server holding the service-role key.
revoke all on function public.apply_ap_drafts(jsonb) from public;
grant execute on function public.apply_ap_drafts(jsonb) to service_role;

commit;

-- Down (reference, not auto-run):
--   revoke execute on function public.apply_ap_drafts(jsonb) from service_role;
--   drop function if exists public.apply_ap_drafts(jsonb);
--   drop index if exists public.ap_tx_practice_today_idx;
--   alter table public.ap_transactions drop column if exists is_practice;
