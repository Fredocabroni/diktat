-- Migration: web_push_delivery — consumes the risk_push decision trail
-- (PR 4.4 / commit a92ce6f) and turns `would_push` decisions into actual
-- web-push notifications.
--
-- Up:
--   1. Create public.user_push_subscriptions:
--        - One row per (user, browser endpoint). Stores the VAPID-encrypted
--          P-256 public key + auth secret per RFC 8030. Soft-delete via
--          disabled_at for audit; the only hard purge is the cascade on
--          users delete.
--        - RLS: self SELECT/INSERT/DELETE for the owning user; UPDATE is
--          service-role only (the worker stamps last_delivered_at +
--          disabled_at; users "pause" via notification_preferences instead).
--   2. Extend public.users with notification_preferences jsonb default '{}'.
--        - Per-notification-type key shape. Default-on policy is "key absent
--          means the type's default-on" — the worker reads
--          coalesce((notification_preferences->>'streak_risk_push')::boolean,
--                   true).
--   3. AFTER UPDATE trigger on public.scheduled_jobs:
--        - When a risk_push row transitions into (status='done' AND
--          payload.decision='would_push'), insert a push_deliver row
--          targeting the same user with idempotency_key = the source row id.
--          Each decision yields at most one delivery row; the existing
--          partial-unique index on (job_type, target_user_id,
--          idempotency_key) defends re-fire scenarios.
--
-- Down (reference, not auto-run):
--   drop trigger if exists trg_enqueue_push_deliver on public.scheduled_jobs;
--   drop function if exists public.enqueue_push_deliver_on_decision();
--   alter table public.users drop column if exists notification_preferences;
--   drop table if exists public.user_push_subscriptions;
--
-- Design context (full scope in plan):
--   * Soft-delete shape on subscriptions: disabled_at + disabled_reason ∈
--     {'gone', 'unauthorized', 'unsubscribed_by_user'}. 410/404 → 'gone'.
--     401 → 'unauthorized' (VAPID rotation). UI toggle →
--     'unsubscribed_by_user'. Re-subscribe is an UPSERT that clears
--     disabled_at + disabled_reason.
--   * Trigger over in-process sweeper: every action is a durable row on the
--     scheduler spine. Delivery inherits retry/backoff/dead-letter for free
--     and matches the local_boundary_sweep / risk_push / fact_check shape.
--   * No new delivery_status column on scheduled_jobs: the delivery handler
--     writes into its OWN push_deliver row's payload, not back into the
--     source risk_push row. Source row stays the immutable decision trail.

begin;

-- ---------------------------------------------------------------------------
-- 1) user_push_subscriptions
-- ---------------------------------------------------------------------------

create table public.user_push_subscriptions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  endpoint          text not null,
  p256dh            text not null,
  auth              text not null,
  user_agent        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_delivered_at timestamptz,
  disabled_at       timestamptz,
  disabled_reason   text check (
    disabled_reason is null
    or disabled_reason in ('gone', 'unauthorized', 'unsubscribed_by_user')
  ),
  -- Pair (disabled_at, disabled_reason) — either both null (active) or both
  -- set (soft-deleted with a known cause). Prevents the audit footgun of a
  -- "disabled, cause unknown" row.
  check (
    (disabled_at is null and disabled_reason is null)
    or (disabled_at is not null and disabled_reason is not null)
  ),
  -- Same browser re-registering is an UPSERT that re-enables a previously
  -- soft-deleted endpoint, not a duplicate.
  unique (user_id, endpoint)
);

-- Worker's hot-path query: subscriptions where disabled_at is null for a
-- given user. Partial index keeps it small.
create index user_push_subscriptions_active_by_user
  on public.user_push_subscriptions (user_id) where disabled_at is null;

create trigger user_push_subscriptions_set_updated_at
  before update on public.user_push_subscriptions
  for each row execute function public.set_updated_at();

alter table public.user_push_subscriptions enable row level security;

-- Self SELECT — user can audit their own subscriptions (active + retired).
create policy user_push_subscriptions_select_self
  on public.user_push_subscriptions for select to authenticated
  using (public.is_self(user_id));

-- Self INSERT — tRPC pushSubscriptions.register sends the PushSubscription
-- via the user's JWT.
create policy user_push_subscriptions_insert_self
  on public.user_push_subscriptions for insert to authenticated
  with check (public.is_self(user_id));

-- Self DELETE — client-side unsubscribe is a hard delete from the user's
-- side. Soft-delete via UPDATE is service-role-only — the worker uses it on
-- 410/404/401, not the client.
create policy user_push_subscriptions_delete_self
  on public.user_push_subscriptions for delete to authenticated
  using (public.is_self(user_id));

-- No UPDATE policy on purpose. The only legitimate writers of
-- last_delivered_at / disabled_at / disabled_reason are workers running
-- with service_role.

-- ---------------------------------------------------------------------------
-- 2) users.notification_preferences
-- ---------------------------------------------------------------------------
-- JSONB column on users. Per-notification-type keys; absent key means the
-- type's default-on policy applies. Existing users_update_self policy
-- already gates self-edits — no additional RLS work.

alter table public.users
  add column if not exists notification_preferences jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 3) enqueue_push_deliver_on_decision trigger
-- ---------------------------------------------------------------------------
-- Fires when a risk_push row transitions into the (status='done' AND
-- payload.decision='would_push') state, exactly once per such transition.
-- The eligibility-edge check (was_eligible vs is_eligible) defends against
-- multiple no-op UPDATEs on the same already-done row (would be rare given
-- the handler's normal flow, but the trigger fires on every UPDATE so we
-- guard at the source).
--
-- The inserted push_deliver row's idempotency_key is the source row's id
-- (text-cast), making each decision yield at most one delivery row. The
-- existing per-user partial-unique index makes the ON CONFLICT clause valid
-- and idempotent.
--
-- Trigger registration uses WHEN(new.job_type='risk_push') to skip the
-- plpgsql entry entirely for the bulk of scheduler-spine UPDATE traffic
-- (heartbeat, local_boundary_sweep, drop_publish, fact_check, etc.). The
-- in-function guard stays as defense in depth.
--
-- Contract: risk_push payloads are IMMUTABLE post-`done`. The handler in
-- apps/workers/src/jobs/risk-push.ts stamps the decision exactly once and
-- never rewrites it; no other code path mutates a done risk_push row. This
-- guarantees the eligibility edge fires at most once per row's lifecycle.
-- A future change that rewrites a done risk_push payload would need to
-- update this trigger's edge check (e.g. gate on `old.processed_at is null`)
-- to preserve the one-delivery-per-decision invariant.

create or replace function public.enqueue_push_deliver_on_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_eligible boolean;
  v_is_eligible boolean;
begin
  if new.job_type <> 'risk_push' then
    return new;
  end if;

  -- risk_push rows are always per-user (the cron predicate selects from
  -- users); a null target_user_id would mean either a manual insert or a
  -- future shape change. Either way, bail rather than fall into the
  -- global-unique partial-index path with an ambiguous idempotency key.
  if new.target_user_id is null then
    return new;
  end if;

  v_is_eligible := (
    new.status = 'done'
    and new.payload->>'decision' = 'would_push'
  );

  v_was_eligible := (
    old.status = 'done'
    and old.payload->>'decision' = 'would_push'
  );

  if v_is_eligible and not v_was_eligible then
    insert into public.scheduled_jobs (
      job_type,
      target_user_id,
      idempotency_key,
      payload
    )
    values (
      'push_deliver',
      new.target_user_id,
      new.id::text,
      jsonb_build_object(
        'source_job_id',  new.id,
        'current_length', new.payload->'current_length',
        'progress',       new.payload->'progress',
        'freezes',        new.payload->'freezes'
      )
    )
    on conflict (job_type, target_user_id, idempotency_key)
      where target_user_id is not null
    do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.enqueue_push_deliver_on_decision() from public;

create trigger trg_enqueue_push_deliver
  after update on public.scheduled_jobs
  for each row
  when (new.job_type = 'risk_push')
  execute function public.enqueue_push_deliver_on_decision();

commit;
