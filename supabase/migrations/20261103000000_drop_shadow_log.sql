-- Migration: drop_shadow_log — nightly shadow-run audit table + cron
--
-- Plan v3 PR I. One row per UTC day captures:
--   - which candidate the real walker actually picked for the Drop,
--   - the top-5 candidates ranked by heat_score at digest time
--     (what the heat composer would have picked),
--   - a field for the operator's manual pick + notes,
--   - the weights snapshot used.
--
-- Generation only — delivery (channel + nightly send) is explicitly
-- deferred to a follow-up PR; the generator writes the row and the
-- follow-up consumes it. See PR description for delivery options.
--
-- RLS: service_role is the only reader AND writer. No app role
-- (anon / authenticated) can read this table — it holds internal
-- heat-pipeline ranking data derived in part from X trends, and
-- the shape of what the composer would have picked is competitive
-- signal that must never leak to app users. The eventual
-- /admin/shadow-review UI reads through a trusted server-side
-- path (service_role) rather than directly from the browser,
-- matching the pattern used by every other heat-pipeline table
-- (trend_signals, drop_candidates, heat_compose_runs).
--
-- Prod max applied at author time: 20261102000000 (Wikimedia
-- validator). Heat pipeline predecessors (all merged): 20261023
-- (M1 trend_signals), 20261024 (matcher), 20261025 (Bluesky
-- cron), 20261030 (X cron), 20261101 (composer), 20261102
-- (Wikimedia validator). This file sorts after all.
--
-- Up:
--   create table public.drop_shadow_log (…).
--   enable RLS; no app-role SELECT policy — service_role only.
--   SECURITY DEFINER RPC record_drop_shadow_log(…).
--   SECURITY DEFINER RPC record_drop_shadow_operator_pick(…) for
--     admin UI write path; NOT FOUND guard; notes length check.
--   pg_cron: drop_shadow_digest daily at 06:00 UTC (post-Drop).
--
-- Down (strict reversal order):
--   select cron.unschedule('drop_shadow_digest');
--   drop function record_drop_shadow_operator_pick, record_drop_shadow_log.
--   drop table public.drop_shadow_log.

begin;

create table public.drop_shadow_log (
  -- One row per UTC day. The digest is scoped to UTC rather than
  -- ET to keep the key simple; the digest payload records the
  -- Drop's ET date for reader context.
  drop_date date primary key,

  -- The walker's actual Drop pick for this day. Soft reference —
  -- no FK on news_topics so a deletion / retention sweep of the
  -- source row doesn't orphan the shadow log.
  real_drop_topic_id uuid,

  -- Top-5 candidates by heat_score at digest time. Shape:
  -- [{ candidate_id, source_title, source_url, heat_score,
  --    heat_components, global_event_id }]
  shadow_top_5 jsonb not null default '[]'::jsonb,

  -- Weights snapshot in use at digest time (HeatWeights shape).
  weights_snapshot jsonb,

  -- Operator-review surface: filled from /admin/shadow-review by
  -- the admin UI through record_drop_shadow_operator_pick(...).
  operator_pick_candidate_id uuid,
  operator_notes text,
  operator_picked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint drop_shadow_log_notes_length
    check (operator_notes is null or char_length(operator_notes) between 1 and 4096)
);

-- Auto-maintain updated_at via the shared trigger.
create trigger drop_shadow_log_set_updated_at
  before update on public.drop_shadow_log
  for each row execute function public.set_updated_at();

-- No secondary index: the admin UI's "last 14 days" reverse-chrono
-- scan uses a backward scan of the drop_date PK index (btree
-- indexes support both directions); at ≤366 rows/year a dedicated
-- (drop_date desc) index is redundant.

comment on table public.drop_shadow_log is
  'Nightly shadow-run audit: top-5 heat picks vs the walker''s real Drop pick + operator manual pick, one row per UTC day. HEAT_ENABLED=false path. Used by /admin/shadow-review and the eventual digest-delivery job.';

alter table public.drop_shadow_log enable row level security;

-- No SELECT policy for anon / authenticated: this is internal
-- heat-pipeline state (X-trends-derived ranking data + what the
-- composer would have picked). RLS enabled + no policy = default
-- deny for every app role. service_role bypasses RLS by role, and
-- the eventual admin UI reads through a trusted server path.

-- =========================================================================
-- SECURITY DEFINER RPCs
-- =========================================================================
-- record_drop_shadow_log: called by the generator worker (service_role).
-- Idempotent upsert on (drop_date). Overwrites `shadow_top_5` + `weights
-- _snapshot` + `real_drop_topic_id` on re-run; preserves operator pick
-- and notes (COALESCE on the ON CONFLICT branch).

create or replace function public.record_drop_shadow_log(
  p_drop_date date,
  p_real_drop_topic_id uuid,
  p_shadow_top_5 jsonb,
  p_weights_snapshot jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.drop_shadow_log as d (
    drop_date,
    real_drop_topic_id,
    shadow_top_5,
    weights_snapshot
  ) values (
    p_drop_date,
    p_real_drop_topic_id,
    coalesce(p_shadow_top_5, '[]'::jsonb),
    p_weights_snapshot
  )
  on conflict (drop_date) do update set
    real_drop_topic_id = excluded.real_drop_topic_id,
    shadow_top_5 = excluded.shadow_top_5,
    weights_snapshot = excluded.weights_snapshot,
    updated_at = now();
    -- operator_pick_candidate_id, operator_notes, operator_picked_at
    -- intentionally NOT touched here — the admin UI owns those.
end;
$$;

revoke all on function public.record_drop_shadow_log(date, uuid, jsonb, jsonb) from public;
grant execute on function public.record_drop_shadow_log(date, uuid, jsonb, jsonb) to service_role;

comment on function public.record_drop_shadow_log is
  'Idempotent upsert for the nightly shadow digest. Overwrites shadow + weights snapshot on re-run; preserves operator fields.';

-- record_drop_shadow_operator_pick: the admin UI writes operator
-- choices via this RPC. For now granted to service_role only (the
-- admin UI calls it via a trusted server-side path, same pattern as
-- the Drop pipeline's SECURITY DEFINER RPCs). When an authenticated
-- admin role lands, a follow-up migration can grant execute to that
-- role.

create or replace function public.record_drop_shadow_operator_pick(
  p_drop_date date,
  p_candidate_id uuid,
  p_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Belt-and-braces length check inside the RPC. The column has an
  -- identical CHECK constraint; this surfaces a clearer error at the
  -- RPC boundary (same errcode class) rather than a generic
  -- constraint-violation deep in the UPDATE.
  if p_notes is not null and char_length(p_notes) not between 1 and 4096 then
    raise exception 'drop_shadow_log.operator_notes length out of range (1..4096): got %', char_length(p_notes)
      using errcode = 'check_violation';
  end if;

  update public.drop_shadow_log
    set operator_pick_candidate_id = p_candidate_id,
        operator_notes = p_notes,
        operator_picked_at = now(),
        updated_at = now()
    where drop_date = p_drop_date;

  -- NOT FOUND guard: a bare UPDATE on a missing row silently
  -- discards the operator pick. Convert that invisible failure
  -- into a surfaced error so the admin UI can message the operator
  -- (e.g. "generator has not run yet for this date").
  if not found then
    raise exception 'drop_shadow_log: no row found for drop_date=%', p_drop_date
      using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.record_drop_shadow_operator_pick(date, uuid, text) from public;
grant execute on function public.record_drop_shadow_operator_pick(date, uuid, text) to service_role;

comment on function public.record_drop_shadow_operator_pick is
  'Admin-write path for the shadow log operator fields. Service-role only today; a future admin-role grant can open this to an authenticated admin JWT once the role lands.';

-- =========================================================================
-- pg_cron — drop_shadow_digest at 06:00 UTC daily
-- =========================================================================
-- 06:00 UTC = 02:00 ET post-Drop (Drop publishes at 20:00 ET).

select cron.schedule(
  'drop_shadow_digest',
  '0 6 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'drop_shadow_digest',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
