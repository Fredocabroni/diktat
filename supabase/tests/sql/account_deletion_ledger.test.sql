-- Behavioural tests for the account-deletion ledger preservation
-- introduced in migration 20261110000000.
--
-- Covers:
--   D1  ap_transactions.user_id FK is ON DELETE SET NULL (not CASCADE).
--   D2  ap_transactions.user_id is nullable post-migration.
--   D3  Deleting a public.users row anonymizes that user's
--       ap_transactions rows (user_id → NULL, every other column
--       preserved).
--   D4  RLS: anonymized row invisible to a different authenticated
--       user via `is_self(user_id)` (null-safety).
--   D5  Service role still sees the anonymized row (ledger audit).
--   D6  delete_my_account REQUIRES a recent (<10 min) last_sign_in_at
--       — a stale session cannot execute the delete.
--   D7  delete_my_account REFUSES while the caller participates in a
--       live battle.
--   D8  delete_my_account SCRUBS the caller's UUID out of every
--       ap_transactions.idempotency_key — no residual UUID anywhere
--       in the ledger, and keys stay UNIQUE.
--   D9  Function privileges — service_role / authenticated grants.

begin;

insert into auth.users (id, email, aud, role, created_at, updated_at)
values
  ('a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', 'del1@test', 'authenticated',
   'authenticated', now(), now()),
  ('b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2', 'other@test', 'authenticated',
   'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.users (id, handle, display_name, current_ap)
values
  ('a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', 'del1_t', 'ToDelete', 100),
  ('b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2', 'other_t', 'Other', 100)
on conflict (id) do nothing;

-- Seed one ap_transactions row for the user we'll delete + one for
-- a sibling user that MUST remain untouched.
insert into public.ap_transactions
  (user_id, delta, balance_after, reason, idempotency_key)
values
  ('a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', 25, 125, 'battle_win',
   'test:del1:battle_win:1'),
  ('b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2', 15, 115, 'battle_win',
   'test:other:battle_win:1')
on conflict (idempotency_key) do nothing;

-- D1: FK is ON DELETE SET NULL (not CASCADE).
do $$
declare v_rule text;
begin
  select confdeltype
    into v_rule
    from pg_constraint
    where conname = 'ap_transactions_user_id_fkey'
      and conrelid = 'public.ap_transactions'::regclass;
  if v_rule is distinct from 'n' then
    raise exception 'D1: ap_transactions_user_id_fkey delete rule is %, expected n (set null)',
      v_rule;
  end if;
end
$$;

-- D2: user_id is nullable.
do $$
declare v_notnull boolean;
begin
  select attnotnull
    into v_notnull
    from pg_attribute
    where attrelid = 'public.ap_transactions'::regclass
      and attname = 'user_id';
  if v_notnull then
    raise exception 'D2: ap_transactions.user_id is NOT NULL; expected nullable';
  end if;
end
$$;

-- D3: Deleting the public.users row sets user_id → NULL on their
-- ap_transactions rows and leaves every other column intact.
do $$
declare
  v_delta_before    int;
  v_balance_before  int;
  v_reason_before   text;
  v_count_before    int;
  v_null_count      int;
  v_other_untouched int;
begin
  select delta, balance_after, reason
    into v_delta_before, v_balance_before, v_reason_before
    from public.ap_transactions
    where idempotency_key = 'test:del1:battle_win:1';
  select count(*) into v_count_before from public.ap_transactions;

  delete from public.users where id = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';

  if (select count(*) from public.ap_transactions) <> v_count_before then
    raise exception 'D3: row was cascade-deleted, expected anonymize';
  end if;

  select count(*)
    into v_null_count
    from public.ap_transactions
    where idempotency_key = 'test:del1:battle_win:1'
      and user_id is null
      and delta = v_delta_before
      and balance_after = v_balance_before
      and reason = v_reason_before;
  if v_null_count <> 1 then
    raise exception 'D3: anonymized row shape wrong (expected 1 null-user row with preserved cols)';
  end if;

  select count(*)
    into v_other_untouched
    from public.ap_transactions
    where idempotency_key = 'test:other:battle_win:1'
      and user_id = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2'
      and delta = 15;
  if v_other_untouched <> 1 then
    raise exception 'D3: other user row was disturbed by the delete';
  end if;
end
$$;

-- D4: Another authenticated user cannot see the anonymized row via
-- the ap_transactions_select_self policy.
do $$
declare v_visible int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2',
                      'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
  select count(*)
    into v_visible
    from public.ap_transactions
    where idempotency_key = 'test:del1:battle_win:1';
  if v_visible <> 0 then
    raise exception 'D4: anonymized row visible to a different user (RLS leak)';
  end if;
end
$$;

-- D5: service_role (postgres superuser in local test) still sees the
-- anonymized row — ledger audit path intact.
do $$
declare v_visible int;
begin
  perform set_config('role', 'postgres', true);
  select count(*)
    into v_visible
    from public.ap_transactions
    where idempotency_key = 'test:del1:battle_win:1';
  if v_visible <> 1 then
    raise exception 'D5: ledger audit cannot see anonymized row from service_role';
  end if;
end
$$;

rollback;

-- D6: delete_my_account REQUIRES a last_sign_in_at within 10 min.
-- Separate transaction — the D3 block already deleted the sentinel
-- auth.users row from the first transaction; this one re-seeds a
-- fresh pair with explicit last_sign_in_at values.
begin;

insert into auth.users (id, email, aud, role, created_at, updated_at, last_sign_in_at)
values
  ('cccccccc-3333-4333-8333-cccccccccccc', 'stale@test', 'authenticated',
   'authenticated', now(), now(), now() - interval '15 minutes'),
  ('dddddddd-4444-4444-8444-dddddddddddd', 'fresh@test', 'authenticated',
   'authenticated', now(), now(), now() - interval '2 minutes')
on conflict (id) do nothing;

insert into public.users (id, handle, display_name, current_ap)
values
  ('cccccccc-3333-4333-8333-cccccccccccc', 'stale_u', 'Stale', 100),
  ('dddddddd-4444-4444-8444-dddddddddddd', 'fresh_u', 'Fresh', 100)
on conflict (id) do nothing;

do $$
declare v_err text;
begin
  -- Masquerade as the stale user.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'cccccccc-3333-4333-8333-cccccccccccc',
                      'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.delete_my_account();
    raise exception 'D6: delete_my_account did not refuse a 15-min-stale session';
  exception when others then
    v_err := SQLERRM;
    if v_err not like '%recent_auth_required%' then
      raise exception 'D6: expected recent_auth_required, got: %', v_err;
    end if;
  end;
end
$$;

-- D7: delete_my_account REFUSES while the caller is in a live battle.
do $$
declare
  v_battle_id uuid := 'eeee5555-5555-4555-8555-eeeeeeeeeeee';
  v_err       text;
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  -- Seed a live battle with the fresh user as a participant.
  insert into public.battles (id, mode, status)
  values (v_battle_id, 'trivia', 'live')
  on conflict (id) do nothing;
  insert into public.battle_participants (battle_id, user_id, seat, entry_ap)
  values (v_battle_id, 'dddddddd-4444-4444-8444-dddddddddddd', 0, 10)
  on conflict (battle_id, user_id) do nothing;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'dddddddd-4444-4444-8444-dddddddddddd',
                      'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.delete_my_account();
    raise exception 'D7: delete_my_account did not refuse an in-live-battle caller';
  exception when others then
    v_err := SQLERRM;
    if v_err not like '%in_live_battle%' then
      raise exception 'D7: expected in_live_battle, got: %', v_err;
    end if;
  end;

  -- Clean up the live battle so D8 can run from a 'no-live' state.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  delete from public.battle_participants where battle_id = v_battle_id;
  delete from public.battles where id = v_battle_id;
end
$$;

-- D8: delete_my_account SCRUBS the caller's UUID out of every
-- idempotency_key — no residual UUID in the ledger after the call.
do $$
declare
  v_user_uuid text := 'dddddddd-4444-4444-8444-dddddddddddd';
  v_residual  int;
  v_distinct_scrubbed int;
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  -- Three keys embedding the caller's UUID, in three different
  -- shapes (signup_grant, debate_entry, custom). All three must be
  -- scrubbed to carry no occurrence of the UUID after the RPC.
  insert into public.ap_transactions
    (user_id, delta, balance_after, reason, idempotency_key)
  values
    ('dddddddd-4444-4444-8444-dddddddddddd', 100, 100, 'admin_adjust',
     'signup_grant:' || v_user_uuid),
    ('dddddddd-4444-4444-8444-dddddddddddd', -5, 95, 'battle_loss',
     'debate_entry:' || v_user_uuid || ':r1'),
    ('dddddddd-4444-4444-8444-dddddddddddd', -5, 90, 'battle_loss',
     'bet:' || v_user_uuid)
  on conflict (idempotency_key) do nothing;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'dddddddd-4444-4444-8444-dddddddddddd',
                      'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
  perform public.delete_my_account();

  -- 0 occurrences of the UUID anywhere in idempotency_key.
  perform set_config('role', 'postgres', true);
  select count(*)
    into v_residual
    from public.ap_transactions
    where idempotency_key like '%' || v_user_uuid || '%';
  if v_residual <> 0 then
    raise exception 'D8: % residual rows still carry the caller UUID in idempotency_key',
      v_residual;
  end if;

  -- Every scrubbed row has a DISTINCT replacement UUID (gen_random_uuid
  -- is per-row). At least 3 distinct `deleted:<uuid>` keys exist.
  select count(distinct idempotency_key)
    into v_distinct_scrubbed
    from public.ap_transactions
    where idempotency_key like 'deleted:%'
       or idempotency_key like '%deleted:%';
  if v_distinct_scrubbed < 3 then
    raise exception 'D8: expected ≥3 distinct scrubbed keys, got %',
      v_distinct_scrubbed;
  end if;
end
$$;

-- D9: Function privileges — authenticated has execute, public does not.
do $$
declare v_auth_exec boolean;
begin
  select has_function_privilege('authenticated', 'public.delete_my_account()', 'execute')
    into v_auth_exec;
  if not v_auth_exec then
    raise exception 'D9: authenticated role lacks EXECUTE on delete_my_account';
  end if;
  if has_function_privilege('public', 'public.delete_my_account()', 'execute') then
    raise exception 'D9: public role should NOT have EXECUTE on delete_my_account';
  end if;
end
$$;

rollback;
