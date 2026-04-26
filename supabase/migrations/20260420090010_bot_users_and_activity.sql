-- Migration: bot accounts + activity tracking
-- Up:   adds public.users.is_bot (default false) and last_active_at,
--       plus two indexes that support matchmaking. Existing RLS on
--       public.users (users_select_authenticated, users_update_self)
--       already covers the new columns — no new policies needed.
-- Down: drop the indexes, drop the columns. Reversible.

begin;

alter table public.users
  add column if not exists is_bot         boolean     not null default false,
  add column if not exists last_active_at timestamptz;

-- Matchmaking range scan: "find non-bot users within ±200 AP of mine"
-- runs as `where is_bot = false and current_ap between $1 and $2`. The
-- composite index serves that filter directly.
create index if not exists users_is_bot_current_ap_idx
  on public.users (is_bot, current_ap);

-- "Active humans only" lookups (matchmaking's bot fallback decides at
-- 30s wait that no human is reachable) sort by last_active_at desc.
-- nulls last keeps never-active rows out of the head of the index.
create index if not exists users_last_active_at_idx
  on public.users (last_active_at desc nulls last);

commit;

-- Down (reference, not auto-run):
--   drop index if exists public.users_last_active_at_idx;
--   drop index if exists public.users_is_bot_current_ap_idx;
--   alter table public.users
--     drop column if exists last_active_at,
--     drop column if exists is_bot;
