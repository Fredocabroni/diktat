-- Migration: account-deletion ledger preservation + delete_my_account RPC.
--
-- Part 1 — ap_transactions user_id FK goes ON DELETE SET NULL.
--
-- When a user deletes their account via the `trpc.user.deleteAccount`
-- mutation, Supabase's auth-admin API deletes the auth.users row,
-- which CASCADEs through public.users.id → auth.users.id and removes
-- every private 1:1 table (streaks, wallets, user_push_subscriptions,
-- debate_posts, debate_votes, take5_sessions,
-- scheduled_jobs.target_user_id, …).
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
-- Part 2 — delete_my_account() SECURITY DEFINER RPC. Enforces three
-- deletion invariants server-side (not only in tRPC):
--
--   a) Recent-auth window. The caller's auth.users.last_sign_in_at
--      must be within the last 10 minutes. Prevents a leaked / shared
--      session from one-click-deleting someone else's account.
--   b) No delete mid-battle. If the caller participates in a battle
--      whose status = 'live', the delete is refused. A merge of the
--      live tick with a mid-run cascade would orphan the opponent
--      and corrupt the AP settlement path.
--   c) Idempotency-key UUID scrub. ap_transactions.user_id goes NULL
--      via the FK's `set null`, but the user's UUID is still embedded
--      in a few idempotency_key patterns (notably `signup_grant:<uuid>`
--      from the handle_new_user trigger, and future AP-pot keys).
--      Replace every substring match of the caller's UUID inside
--      idempotency_key with `deleted:<new uuid>` — the UNIQUE index
--      on idempotency_key stays satisfied because gen_random_uuid()
--      is VOLATILE (one fresh UUID per row).
--
-- The RPC does NOT call auth.users DELETE itself — Supabase's
-- auth-admin API is service-role-only and the client's bearer gets
-- the public shell. The tRPC resolver calls this RPC first for the
-- atomic gate + scrub, THEN calls admin.auth.admin.deleteUser(ctx.userId)
-- to trigger the cascade. If the admin call fails, the scrub stands;
-- the keys are already-anonymised but the row is still there — a
-- small forward-only cleanup drift, not a security hole.
--
-- Up:
--   alter table public.ap_transactions
--     alter column user_id drop not null,
--     drop constraint ap_transactions_user_id_fkey,
--     add constraint ap_transactions_user_id_fkey
--       foreign key (user_id) references public.users(id) on delete set null;
--   create or replace function public.delete_my_account() ...
--
-- Down: see Down of the FK, plus `drop function public.delete_my_account()`.

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

-- delete_my_account() — the server-side gate + idempotency-key scrub.
-- SECURITY DEFINER so the raise P0001 branches reach a client that
-- holds only the public shell; the function reads auth.users via the
-- definer's elevated privileges. search_path = '' to prevent search-
-- path shadowing of either `public` or `auth` by a session setting.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id       uuid;
  v_last_sign_in  timestamptz;
  v_in_live       int;
  v_scrubbed      int;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'delete_my_account: unauthenticated'
      using errcode = '28000';
  end if;

  -- (a) Recent-auth window: last_sign_in_at within the last 10 minutes.
  -- Supabase stamps `auth.users.last_sign_in_at` on every token
  -- issuance (magic-link exchange, OAuth callback, refresh). A null
  -- value means the account has never completed a sign-in — treat as
  -- stale (no recent auth).
  select u.last_sign_in_at
    into v_last_sign_in
    from auth.users u
    where u.id = v_user_id;
  if v_last_sign_in is null
     or v_last_sign_in < now() - interval '10 minutes' then
    raise exception 'delete_my_account: recent_auth_required'
      using errcode = 'P0001';
  end if;

  -- (b) No delete mid-battle: refuse if the caller participates in a
  -- battle whose status = 'live'. Queued battles are fine — the
  -- auth-admin delete that follows will cascade through
  -- battle_participants (ON DELETE CASCADE at the FK) and the row is
  -- gone before matchmaking pairs it. 'settled' / 'cancelled' are
  -- terminal, so they also pose no risk.
  select count(*)
    into v_in_live
    from public.battle_participants bp
    join public.battles b on b.id = bp.battle_id
    where bp.user_id = v_user_id
      and b.status = 'live';
  if v_in_live > 0 then
    raise exception 'delete_my_account: in_live_battle'
      using errcode = 'P0001';
  end if;

  -- (c) Idempotency-key UUID scrub. The signup_grant trigger
  -- (migration 20260420090007) writes `signup_grant:<uuid>` as the
  -- idempotency_key; future RPCs may embed the caller's UUID in other
  -- key shapes. Rewrite every match of the caller's UUID (as text) to
  -- `deleted:<fresh uuid>` so the UNIQUE index stays satisfied — the
  -- VOLATILE gen_random_uuid() evaluates per row, so N rows produce
  -- N distinct replacements.
  --
  -- The replace() call is unconditional on the matching rows only;
  -- the WHERE clause uses a LIKE prefilter so the full-table scan
  -- paid is proportional to the caller's row count, not the ledger
  -- size (the ap_tx_user_recent_idx index on (user_id, created_at)
  -- also narrows to this caller's rows for the scrub step via the
  -- user_id = v_user_id branch of the OR). The LIKE pattern uses the
  -- caller's uuid as a literal substring; it never embeds user-
  -- controlled data (auth.uid() is a server-authoritative uuid).
  update public.ap_transactions
     set idempotency_key = replace(
           idempotency_key,
           v_user_id::text,
           'deleted:' || gen_random_uuid()::text
         )
   where user_id = v_user_id
      or idempotency_key like '%' || v_user_id::text || '%';
  get diagnostics v_scrubbed = row_count;

  return jsonb_build_object(
    'ok', true,
    'scrubbed', v_scrubbed
  );
end;
$$;

comment on function public.delete_my_account() is
  'Pre-flight for account deletion: recent-auth check, live-battle '
  'check, idempotency-key UUID scrub. tRPC resolver calls this before '
  'auth-admin deleteUser so the cascade finds anonymised keys and '
  'cannot land mid-live-battle. SECURITY DEFINER / search_path=''''.';

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

commit;
