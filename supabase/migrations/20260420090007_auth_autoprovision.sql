-- Migration: extend auth signup auto-provision to include wallet + AP audit row
-- Up:   replace public.handle_new_user() so it also inserts public.wallets
--       and a single public.ap_transactions row (idempotency_key 'signup_grant:<uuid>').
--       Handle prefix moves user_ → citizen_ (civic vocabulary, copy-linter aligned).
-- Down: restore the prior body (users + streaks only). See bottom of file.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- public.users: PK = auth.users.id. Default current_ap = 100 (migration 0002).
  insert into public.users (id, handle)
  values (new.id, 'citizen_' || substr(replace(new.id::text,'-',''), 1, 10))
  on conflict (id) do nothing;

  -- public.streaks: 1:1 with users (user_id is PK).
  insert into public.streaks (user_id) values (new.id)
  on conflict (user_id) do nothing;

  -- public.wallets: 1:1 with users (user_id UNIQUE). Real Privy custodial-wallet
  -- creation is server-side and lands in Phase 3; for now we record an empty
  -- shell so wallet.balance queries always have a row to read.
  insert into public.wallets (user_id, provider, status)
  values (new.id, 'privy', 'active')
  on conflict (user_id) do nothing;

  -- 100 AP starter grant — AUDIT ROW ONLY. users.current_ap already defaults
  -- to 100 in migration 0002, so this insert does NOT double-credit. The
  -- 'signup_grant:<uuid>' idempotency key plus the UNIQUE index on
  -- ap_transactions.idempotency_key make a duplicate grant impossible even
  -- if this trigger fires twice for the same auth.users row.
  insert into public.ap_transactions
    (user_id, delta, balance_after, reason, idempotency_key)
  values
    (new.id, 100, 100, 'admin_adjust', 'signup_grant:' || new.id::text)
  on conflict (idempotency_key) do nothing;

  return new;
end;
$$;

commit;

-- Down (reference, not auto-run):
--   create or replace function public.handle_new_user()
--   returns trigger language plpgsql security definer set search_path = ''
--   as $$
--   begin
--     insert into public.users (id, handle)
--     values (new.id, 'user_' || substr(replace(new.id::text,'-',''), 1, 10))
--     on conflict (id) do nothing;
--     insert into public.streaks (user_id) values (new.id)
--     on conflict (user_id) do nothing;
--     return new;
--   end;
--   $$;
