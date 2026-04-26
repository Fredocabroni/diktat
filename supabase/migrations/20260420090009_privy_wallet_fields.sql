-- Migration: privy custodial-wallet fields + handle_new_user pg_notify
-- Up:   adds privy_user_id (partial unique), solana_address, evm_address to
--       public.wallets; rewrites public.handle_new_user() to emit a
--       'privy_provision' NOTIFY for non-bot signups so the workers listener
--       can provision a custodial wallet asynchronously. Bot accounts
--       (raw_app_meta_data->>'is_bot' = 'true') still get the full row set
--       but skip the NOTIFY — that's the cross-PR contract with the
--       matchmaking bot seeds (migration 0011).
-- Down: drop the new columns + index, restore handle_new_user to the 0007 body.

begin;

-- 1) New columns on public.wallets.
alter table public.wallets
  add column if not exists privy_user_id  text,
  add column if not exists solana_address text,
  add column if not exists evm_address    text;

-- Partial unique index so existing shells (privy_user_id is null) don't
-- collide. Once provisioned, each Privy user id maps to exactly one wallet.
create unique index if not exists wallets_privy_user_id_uniq
  on public.wallets (privy_user_id)
  where privy_user_id is not null;

-- 2) Replace handle_new_user(). Body mirrors 0007 verbatim; the only
--    behavioural change is the conditional pg_notify at the end. Inserts
--    still run for bot accounts so PR #15's seed_bot() helper has rows
--    to UPDATE (handle / current_ap / is_bot).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_bot boolean := coalesce(new.raw_app_meta_data->>'is_bot', 'false') = 'true';
begin
  -- public.users: PK = auth.users.id. Default current_ap = 100 (migration 0002).
  insert into public.users (id, handle)
  values (new.id, 'citizen_' || substr(replace(new.id::text,'-',''), 1, 10))
  on conflict (id) do nothing;

  -- public.streaks: 1:1 with users (user_id is PK).
  insert into public.streaks (user_id) values (new.id)
  on conflict (user_id) do nothing;

  -- public.wallets: 1:1 with users (user_id UNIQUE). Empty shell here; the
  -- workers listener UPDATEs it with privy_user_id / solana_address once
  -- Privy returns. Bots never get notify'd.
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

  -- Async Privy provisioning. Non-bots only. The workers listener is the
  -- consumer; payload is the user uuid as text. Failure of the listener
  -- never blocks signup — pg_notify is fire-and-forget.
  if not v_is_bot then
    perform pg_notify('privy_provision', new.id::text);
  end if;

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
--     values (new.id, 'citizen_' || substr(replace(new.id::text,'-',''), 1, 10))
--     on conflict (id) do nothing;
--     insert into public.streaks (user_id) values (new.id)
--     on conflict (user_id) do nothing;
--     insert into public.wallets (user_id, provider, status)
--     values (new.id, 'privy', 'active')
--     on conflict (user_id) do nothing;
--     insert into public.ap_transactions
--       (user_id, delta, balance_after, reason, idempotency_key)
--     values
--       (new.id, 100, 100, 'admin_adjust', 'signup_grant:' || new.id::text)
--     on conflict (idempotency_key) do nothing;
--     return new;
--   end;
--   $$;
--   drop index if exists public.wallets_privy_user_id_uniq;
--   alter table public.wallets
--     drop column if exists evm_address,
--     drop column if exists solana_address,
--     drop column if exists privy_user_id;
