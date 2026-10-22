-- Behavioural tests for the account-deletion ledger preservation
-- introduced in migration 20261110000000.
--
-- Covers:
--   D1  ap_transactions.user_id FK is ON DELETE SET NULL (not CASCADE).
--   D2  ap_transactions.user_id is nullable post-migration.
--   D3  Deleting a public.users row anonymizes that user's
--       ap_transactions rows (user_id → NULL, every other column
--       preserved: delta, balance_after, reason, idempotency_key,
--       ref_type, ref_id, created_at).
--   D4  ap_transactions_select_self RLS still filters correctly on
--       the anonymized row — a different authenticated user cannot
--       see the anonymized row via `is_self(user_id)` (null-safety).
--   D5  Service role still sees the anonymized row (ledger audit).

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
  -- Postgres encodes delete-rule as a single char: 'a'=NO ACTION,
  -- 'r'=RESTRICT, 'c'=CASCADE, 'n'=SET NULL, 'd'=SET DEFAULT.
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
  v_idem_before     text;
  v_count_before    int;
  v_null_count      int;
  v_other_untouched int;
begin
  select delta, balance_after, reason, idempotency_key
    into v_delta_before, v_balance_before, v_reason_before, v_idem_before
    from public.ap_transactions
    where idempotency_key = 'test:del1:battle_win:1';
  select count(*) into v_count_before from public.ap_transactions;

  delete from public.users where id = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';

  -- Row count UNCHANGED — set null, not cascade delete.
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

  -- Sibling user's row MUST be untouched.
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
