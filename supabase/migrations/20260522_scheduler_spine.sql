-- Migration: phase4_scheduler_spine
-- Up:   Enable pg_cron. Create public.scheduled_jobs (durable due-table with
--       two partial-unique idempotency indexes, claim index, RLS-enabled-no-
--       policies). Add public.users.timezone (IANA, default America/New_York).
--       Schedule drop_due_check (hourly, DST-correct ET wall-clock guard with
--       >= 20 catch-up) and scheduler_heartbeat (every 15 min liveness probe).
-- Down: cron.unschedule('drop_due_check'); cron.unschedule('scheduler_heartbeat');
--       drop function public.claim_scheduled_jobs(text[], int, text);
--       drop table public.scheduled_jobs; alter table public.users drop column
--       timezone; -- pg_cron extension left in place (idempotent, harmless).
--
-- Why these design choices:
--   * idempotency_key text (not target_date date): a single key serves both
--     date-bound jobs (e.g. drop_publish -> '2026-05-22') and bucketed liveness
--     (heartbeat -> '2026-05-22 20:15'). The two partial-unique indexes use it.
--   * RLS on, no policies: scheduled_jobs is internal infra. pg_cron runs as
--     postgres (RLS bypass); the workers consumer uses service_role (RLS bypass).
--     Clients never touch this table.
--   * pg_cron schedules in UTC; America/New_York wall-clock arithmetic inside
--     the cron SQL handles DST without schedule edits twice a year.
--   * >= 20 (not = 20) + ON CONFLICT DO NOTHING is the catch-up mechanism for
--     the "never skip a day" Drop invariant: any 20:00..23:59 ET hourly tick
--     emits the row if missing; the first wins, the rest no-op.
--   * Phase 4 follow-ups (deferred to PR 4.4): streak columns, streak-lock SQL,
--     */15 local_boundary_sweep cron, risk_push emission.

begin;

create extension if not exists pg_cron;

-- users.timezone: shared infra column. IANA name. App layer validates against
-- Intl.supportedValuesOf('timeZone') on writes (user.setTimezone tRPC). No DB
-- CHECK because pg_timezone_names is a view, not an immutable function.
alter table public.users
  add column if not exists timezone text not null default 'America/New_York';

-- scheduled_jobs: cron emits idempotent due-rows; workers poll claims and
-- dispatches by job_type. Until a job_type's handler is registered (in this
-- PR: only 'heartbeat'), rows of that type accumulate untouched -- the table
-- itself is the durable cross-PR contract.
create table public.scheduled_jobs (
  id              uuid primary key default gen_random_uuid(),
  job_type        text not null,
  -- Each job_type picks its own key format. Examples:
  --   drop_publish  -> '<ET date>'                e.g. '2026-05-22'
  --   heartbeat     -> '<UTC YYYY-MM-DD HH24:MI>' e.g. '2026-05-22 20:15'
  --   risk_push     -> '<user local date>'        (future PR)
  idempotency_key text not null,
  target_user_id  uuid references public.users(id) on delete cascade,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending'
                    check (status in ('pending','processing','done','failed','dead')),
  attempts        int not null default 0,
  max_attempts    int not null default 5 check (max_attempts >= 1),
  available_at    timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Idempotency. Two partial unique indexes (explicit; readable vs the PG17
-- NULLS NOT DISTINCT alternative).
create unique index scheduled_jobs_global_unique
  on public.scheduled_jobs (job_type, idempotency_key)
  where target_user_id is null;

create unique index scheduled_jobs_per_user_unique
  on public.scheduled_jobs (job_type, target_user_id, idempotency_key)
  where target_user_id is not null;

-- Claim index for the workers poll. Partial on pending rows -- the only ones
-- the consumer's claim query ever scans.
create index scheduled_jobs_pending_claim
  on public.scheduled_jobs (available_at)
  where status = 'pending';

-- FK index for target_user_id. The two partial-unique indexes lead with
-- job_type, so a user-delete cascade would otherwise seq-scan to find the
-- referencing rows. Partial keeps it small (global rows have no user).
create index scheduled_jobs_target_user_id_idx
  on public.scheduled_jobs (target_user_id)
  where target_user_id is not null;

create trigger scheduled_jobs_set_updated_at
  before update on public.scheduled_jobs
  for each row execute function public.set_updated_at();

-- RLS enabled, NO policies on purpose. Internal table.
alter table public.scheduled_jobs enable row level security;

-- Belt-and-suspenders: even though no policy grants client access, explicitly
-- revoke from anon/authenticated to defend against a future SECURITY DEFINER
-- view or wrapper accidentally surfacing this table.
revoke all on public.scheduled_jobs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- claim_scheduled_jobs: atomic batch claim with FOR UPDATE SKIP LOCKED.
-- Supabase JS cannot express FOR UPDATE; this function is the consumer's
-- only way to claim safely under concurrency. Called via supabase.rpc(...).
-- SECURITY DEFINER matches the repo pattern (handle_new_user / apply_ap_drafts).
-- ---------------------------------------------------------------------------
create or replace function public.claim_scheduled_jobs(
  p_handler_types text[],
  p_limit int,
  p_worker_id text
)
returns setof public.scheduled_jobs
language sql
security definer
set search_path = public, pg_temp
as $fn$
  update public.scheduled_jobs
  set    status      = 'processing',
         attempts    = attempts + 1,
         locked_at   = now(),
         locked_by   = p_worker_id,
         updated_at  = now()
  where  id in (
    select id from public.scheduled_jobs
    where  status        = 'pending'
      and  available_at <= now()
      and  job_type      = any(p_handler_types)
    order by available_at
    limit  p_limit
    for update skip locked
  )
  returning *;
$fn$;

-- Lock down execute. Postgres implicitly grants EXECUTE to PUBLIC on new
-- functions; revoke it so only roles with an explicit grant can call this.
-- service_role retains EXECUTE via the default-priv block in
-- 20260427_grant_service_role_public.sql.
revoke execute on function public.claim_scheduled_jobs(text[], int, text) from public;

-- ---------------------------------------------------------------------------
-- cron entries
-- ---------------------------------------------------------------------------
-- cron.schedule(name, schedule, command) is idempotent by name: re-running
-- this migration upserts the schedule rather than erroring.

-- (1) drop_due_check -- hourly. DST-correct ET wall-clock guard with catch-up.
-- The hourly cadence + the `>= 20` guard + the ON CONFLICT DO NOTHING means
-- the first 20:00..23:59 ET tick of the day emits the drop_publish row; later
-- hourly ticks that day are idempotent no-ops. Catches up across cron hiccups
-- within the evening window. PR 4.2 registers the drop_publish handler in the
-- workers consumer; until then, drop_publish rows sit pending durably.
select cron.schedule(
  'drop_due_check',
  '0 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    select 'drop_publish',
           to_char((now() at time zone 'America/New_York')::date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'emitted_at_et', to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI:SS'),
             'et_hour', extract(hour from now() at time zone 'America/New_York')
           )
    where extract(hour from now() at time zone 'America/New_York') >= 20
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

-- (2) scheduler_heartbeat -- every 15 min liveness probe. Flows
-- cron -> row -> workers poll -> heartbeat handler -> 'done'. Newest 'done'
-- heartbeat older than ~20 min indicates the spine is degraded (either cron
-- or the consumer). Key is the wall-clock minute (rounded by cron's fire);
-- distinct keys per tick, ON CONFLICT defends against accidental double-fire.
select cron.schedule(
  'scheduler_heartbeat',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key)
    values ('heartbeat', to_char(now(), 'YYYY-MM-DD HH24:MI'))
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
