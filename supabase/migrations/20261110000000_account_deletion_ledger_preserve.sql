-- Migration: account-deletion ledger preservation.
--
-- Shift `ap_transactions.user_id` from `on delete cascade` to
-- `on delete set null`. When a user deletes their account via the
-- `trpc.user.deleteAccount` mutation, Supabase's auth-admin API
-- deletes the auth.users row, which CASCADEs through
-- public.users.id → auth.users.id and removes every private 1:1
-- table (streaks, wallets, user_push_subscriptions, debate_posts,
-- debate_votes, take5_sessions, scheduled_jobs.target_user_id, …).
--
-- `ap_transactions` is the one row-set we do NOT want to lose: the
-- economy's ledger would develop audit holes, and `balance_after`
-- would stop being a continuous proof. Flipping to `set null`
-- anonymizes the deleted actor's rows (user_id → NULL) without
-- breaking the ledger continuity for everyone else.
--
-- Deletion matrix post-this-migration:
--   auth.users row                              → DELETED (admin API)
--   public.users row (FK)                       → DELETED (cascade)
--   public.streaks / wallets / sessions          → DELETED (cascade)
--   public.user_push_subscriptions              → DELETED (cascade)
--   public.debate_posts / _votes / _args        → DELETED (cascade)
--   public.take5_sessions / opinion_shifts      → DELETED (cascade)
--   public.ap_transactions                       → ANONYMIZED (user_id → NULL)
--   public.battles.winner_user_id et al         → NULLED (set null, was already)
--   public.fact_check_claims created_by et al   → NULLED (set null, was already)
--
-- Up:
--   alter table public.ap_transactions
--     alter column user_id drop not null,
--     drop constraint ap_transactions_user_id_fkey,
--     add constraint ap_transactions_user_id_fkey
--       foreign key (user_id) references public.users(id) on delete set null;
--
-- Down:
--   alter table public.ap_transactions
--     drop constraint ap_transactions_user_id_fkey,
--     add constraint ap_transactions_user_id_fkey
--       foreign key (user_id) references public.users(id) on delete cascade,
--     alter column user_id set not null;
--   (Note: making user_id NOT NULL again is NOT safe once anonymized
--   rows exist — the alter will fail. In practice the down is a
--   "forward only" migration past the first deletion.)

begin;

alter table public.ap_transactions
  alter column user_id drop not null;

alter table public.ap_transactions
  drop constraint ap_transactions_user_id_fkey;

alter table public.ap_transactions
  add constraint ap_transactions_user_id_fkey
    foreign key (user_id) references public.users(id) on delete set null;

-- The existing `ap_tx_select_self` RLS policy (migration
-- 20260420090002) filters on `is_self(user_id)`, which returns false
-- when user_id is null (an anonymized row). Deleted-actor rows are
-- therefore invisible to end users and visible only to service_role,
-- which is the posture we want for ledger audit without re-exposing
-- the deleted user's history.
--
-- No index change: the existing `ap_tx_user_recent_idx` on
-- `(user_id, created_at desc)` keeps working for lookups; btree
-- indexes include null keys at one end, so null-user_id rows don't
-- degrade scans by handle.

comment on constraint ap_transactions_user_id_fkey on public.ap_transactions is
  'ON DELETE SET NULL — see migration 20261110000000. When a user '
  'deletes their account, their ap_transactions rows are anonymized '
  '(user_id → NULL) rather than cascade-deleted, so the economy ledger '
  'stays continuous and auditable.';

commit;
