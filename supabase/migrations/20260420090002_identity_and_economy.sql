-- Migration: identity + economy tables
-- Up:   tiers, users, wallets, ap_transactions, streaks, sessions. RLS enforced.
-- Down: drop in reverse FK order. Reversible.

begin;

create table public.tiers (
  id                smallint primary key check (id between 0 and 11),
  name              text not null unique,
  ap_min            integer not null check (ap_min >= 0),
  ap_max            integer check (ap_max is null or ap_max >= ap_min),
  payout_eligible   boolean not null default false,
  floor_protected   boolean not null default false,
  cosmetics         jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger tiers_set_updated_at before update on public.tiers
  for each row execute function public.set_updated_at();
alter table public.tiers enable row level security;
create policy tiers_select_all on public.tiers for select to anon, authenticated using (true);

create table public.users (
  id                uuid primary key references auth.users(id) on delete cascade,
  handle            citext not null unique,
  display_name      text,
  avatar_url        text,
  current_ap        integer not null default 100 check (current_ap >= 0),
  tier_id           smallint not null default 0 references public.tiers(id) on update cascade,
  fingerprint       jsonb not null default '{}'::jsonb,
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index users_tier_id_idx on public.users (tier_id);
create index users_handle_idx  on public.users (handle);
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();
alter table public.users enable row level security;
create policy users_select_authenticated on public.users for select to authenticated using (true);
create policy users_update_self on public.users for update to authenticated
  using (public.is_self(id)) with check (public.is_self(id));

-- Auto-provision a public.users row + streak when a new auth.users row is created.
-- Wallet provisioning runs server-side via the Privy webhook (service-role).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, handle)
  values (new.id, 'user_' || substr(replace(new.id::text,'-',''), 1, 10))
  on conflict (id) do nothing;
  insert into public.streaks (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.wallets (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references public.users(id) on delete cascade,
  provider            text not null default 'privy',
  external_wallet_id  text,
  usdc_balance_micro  bigint not null default 0 check (usdc_balance_micro >= 0),
  display_currency    text not null default 'USD',
  status              text not null default 'active' check (status in ('active','frozen','closed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index wallets_user_id_idx on public.wallets (user_id);
create trigger wallets_set_updated_at before update on public.wallets
  for each row execute function public.set_updated_at();
alter table public.wallets enable row level security;
-- INSERT/UPDATE handled by service-role workers (Privy webhook). No client policy by design.
create policy wallets_select_self on public.wallets for select to authenticated
  using (public.is_self(user_id));

create table public.ap_transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  delta             integer not null,
  balance_after     integer not null check (balance_after >= 0),
  reason            text not null check (reason in (
                       'battle_win','battle_loss','prediction_settle',
                       'ghost_credit','streak_bonus','admin_adjust'
                     )),
  ref_type          text,
  ref_id            uuid,
  idempotency_key   text not null unique,
  created_at        timestamptz not null default now()
);
create index ap_tx_user_recent_idx on public.ap_transactions (user_id, created_at desc);
create index ap_tx_ref_idx         on public.ap_transactions (ref_type, ref_id);
alter table public.ap_transactions enable row level security;
create policy ap_tx_select_self on public.ap_transactions for select to authenticated
  using (public.is_self(user_id));

create table public.streaks (
  user_id            uuid primary key references public.users(id) on delete cascade,
  current_length     integer not null default 0 check (current_length >= 0),
  longest_length     integer not null default 0 check (longest_length >= 0),
  last_action_date   date,
  freeze_tokens      integer not null default 0 check (freeze_tokens >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger streaks_set_updated_at before update on public.streaks
  for each row execute function public.set_updated_at();
alter table public.streaks enable row level security;
-- writes performed by service-role only (AP engine). Clients only read.
create policy streaks_select_self on public.streaks for select to authenticated
  using (public.is_self(user_id));

create table public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  device_kind  text,
  app_version  text,
  created_at   timestamptz not null default now()
);
create index sessions_user_started_idx on public.sessions (user_id, started_at desc);
alter table public.sessions enable row level security;
create policy sessions_select_self on public.sessions for select to authenticated
  using (public.is_self(user_id));
create policy sessions_insert_self on public.sessions for insert to authenticated
  with check (
    public.is_self(user_id)
    and started_at <= now()
    and started_at >= now() - interval '1 minute'
  );
create policy sessions_update_self on public.sessions for update to authenticated
  using (public.is_self(user_id) and ended_at is null)
  with check (public.is_self(user_id));

commit;

-- Down (reference, not auto-run):
--   drop table public.sessions, public.streaks, public.ap_transactions,
--              public.wallets, public.users, public.tiers cascade;
