-- Security fix (audit H3): close the un-debited prediction-insert hole.
--
-- BACKGROUND. `predictions_insert_self` let any authenticated user INSERT a
-- prediction directly via PostgREST, validating only ownership/status/nulls. It
-- NEVER debited current_ap and NEVER checked balance -- a user could stake AP
-- they don't have, at zero cost.
--
-- The prediction feature is a NON-FUNCTIONAL STUB: there is no credit half at
-- all -- no settlement RPC, no `prediction_settle` writer, no resolution source,
-- no cron. Shipping only the debit would invert "free stake" into "AP burns with
-- no payout," which is worse for users. So this migration closes the security
-- hole WITHOUT exposing any stake path:
--   (a) DROP predictions_insert_self          -> no direct authenticated insert.
--   (b) EXTEND ap_transactions.reason         -> allow 'prediction_stake' (additive).
--   (c) ADD place_prediction(...) RPC         -> the correct atomic-debit primitive
--       (FOR UPDATE + balance check + ledger row), ready for when predictions is
--       properly built. It is NOT wired to any router/API in this PR; nothing new
--       is reachable by a client.
--
-- DO NOT expose a stake path (a `predictions.place` router or any caller) until
-- the credit half -- a settlement RPC using the reserved reason 'prediction_settle'
-- plus a resolution source and a cron trigger -- lands as one coherent loop.
-- Tracked in the full-feature issue linked from PR.

-- Wrapped in a single transaction so the reason-constraint swap is atomic: a
-- failed `add constraint` can never leave the table with the CHECK dropped
-- (which would let any reason string insert). Matches the repo house style.
begin;

-- (a) Drop the un-debited direct-insert policy. `predictions_select_self` (users
--     read their own) and service-role settlement writes are unaffected.
drop policy if exists predictions_insert_self on public.predictions;

-- (b) Additive: allow the stake-debit ledger reason. The constraint is the
--     inline column check auto-named `ap_transactions_reason_check`. Existing
--     rows and reasons stay valid; we only add a value. `if exists` matches the
--     repo house style and keeps the drop safe under partial re-apply.
alter table public.ap_transactions drop constraint if exists ap_transactions_reason_check;
alter table public.ap_transactions add constraint ap_transactions_reason_check
  check (reason in (
    'battle_win',
    'battle_loss',
    'prediction_stake',
    'prediction_settle',
    'ghost_credit',
    'streak_bonus',
    'admin_adjust'
  ));

-- (c) The atomic debit primitive. Derives the user from auth.uid() (never a
--     caller-supplied id -- matches submit_trivia_answer). One transaction:
--     lock -> balance check -> debit -> open prediction -> ledger row.
create or replace function public.place_prediction(
  p_topic_id           uuid,
  p_direction          text,
  p_ap_stake           integer,
  p_market_external_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user          uuid;
  v_current_ap    integer;
  v_prediction_id uuid;
begin
  -- (1) Auth. EXECUTE is granted to `authenticated` only and PUBLIC is revoked;
  --     the inline guard is defence-in-depth if the role check is loosened.
  v_user := auth.uid();
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- (2) Input validation -- defence in depth alongside the table CHECK
  --     constraints (ap_stake > 0, direction in ('yes','no')).
  if p_ap_stake is null or p_ap_stake <= 0 then
    raise exception 'ap_stake must be a positive integer' using errcode = '22023';
  end if;
  if p_direction is null or p_direction not in ('yes', 'no') then
    raise exception 'direction must be yes or no' using errcode = '22023';
  end if;

  -- (3) Topic must exist. The FK on predictions.topic_id would also catch this,
  --     but a named error is clearer than a constraint violation.
  if not exists (select 1 from public.news_topics t where t.id = p_topic_id) then
    raise exception 'topic not found' using errcode = 'P0002';
  end if;

  -- (4) Lock the caller's row for the balance check + debit.
  select current_ap into v_current_ap
    from public.users
    where id = v_user
    for update;
  if v_current_ap is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  -- (5) Balance check -- the whole point of H3. No overdraft.
  if v_current_ap < p_ap_stake then
    raise exception 'insufficient_ap' using errcode = 'P0001';
  end if;

  -- (6) Debit.
  update public.users
    set current_ap = current_ap - p_ap_stake
    where id = v_user;

  -- (7) Record the open prediction.
  insert into public.predictions (
    topic_id, user_id, market_external_id, direction, ap_stake, status
  )
  values (
    p_topic_id, v_user, p_market_external_id, p_direction, p_ap_stake, 'open'
  )
  returning id into v_prediction_id;

  -- (8) Ledger the debit. idempotency_key is unique per stake by construction
  --     (one prediction row = one stake); the UNIQUE index still blocks any
  --     accidental duplicate.
  insert into public.ap_transactions (
    user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key
  )
  values (
    v_user,
    -p_ap_stake,
    v_current_ap - p_ap_stake,
    'prediction_stake',
    'prediction',
    v_prediction_id,
    'prediction_stake:' || v_prediction_id::text
  );

  return v_prediction_id;
end;
$$;

revoke all on function public.place_prediction(uuid, text, integer, text) from public;
grant execute on function public.place_prediction(uuid, text, integer, text) to authenticated, service_role;

comment on function public.place_prediction(uuid, text, integer, text) is
  'Atomically stake AP on a prediction: auth.uid() -> FOR UPDATE lock -> balance check -> debit -> open prediction -> prediction_stake ledger row. NOT exposed via any router in the PR that introduced it: predictions is a non-functional stub until the credit/settlement half (reason=prediction_settle + resolution + cron) lands. Do not wire a stake path until then.';

commit;

-- Down (reference, not auto-run):
--   begin;
--   drop function if exists public.place_prediction(uuid, text, integer, text);
--   drop policy if exists predictions_insert_self on public.predictions;
--   create policy predictions_insert_self on public.predictions for insert to authenticated
--     with check (public.is_self(user_id) and status = 'open'
--                 and ap_payout is null and settled_at is null);
--   -- Only safe once no ap_transactions row uses reason='prediction_stake'
--   -- (else the re-add fails validation):
--   alter table public.ap_transactions drop constraint if exists ap_transactions_reason_check;
--   alter table public.ap_transactions add constraint ap_transactions_reason_check
--     check (reason in ('battle_win','battle_loss','prediction_settle',
--                       'ghost_credit','streak_bonus','admin_adjust'));
--   commit;
