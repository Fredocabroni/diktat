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
-- RLS: service_role is the only writer. Reads are granted to
-- `authenticated` for admins + the eventual /admin/shadow-review
-- UI; this is operator-review surface, not political-content
-- surface, so public read is acceptable per the "transparent-math
-- §2" posture used by gdelt_event_cluster. If future digest rows
-- carry X trend text we revisit (today's shadow log carries
-- candidate IDs + heat_score only, no third-party trend text).
--
-- Prod max applied: 20261022000000. Predecessors (unmerged
-- siblings): 20261023 (M1), 20261024 (matcher), 20261025 (Bluesky
-- cron), 20261026 (X cron), 20261027 (Wikimedia cron),
-- 20261028 (composer). This file sorts after all.
--
-- Up:
--   create table public.drop_shadow_log (…).
--   enable RLS; select to authenticated; service_role writer.
--   SECURITY DEFINER RPC record_drop_shadow_log(…).
--   SECURITY DEFINER RPC record_drop_shadow_operator_pick(…) for
--     admin UI write path.
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

-- Reverse-chrono scan for the admin UI "last 14 days".
create index drop_shadow_log_drop_date_desc_idx
  on public.drop_shadow_log (drop_date desc);

comment on table public.drop_shadow_log is
  'Nightly shadow-run audit: top-5 heat picks vs the walker''s real Drop pick + operator manual pick, one row per UTC day. HEAT_ENABLED=false path. Used by /admin/shadow-review and the eventual digest-delivery job.';

alter table public.drop_shadow_log enable row level security;

-- Public read: this is operator-review state; no user PII; no X
-- Developer Agreement surface (candidate IDs + heat_score only).
create policy drop_shadow_log_select_authenticated
  on public.drop_shadow_log
  for select to authenticated using (true);

grant select on public.drop_shadow_log to authenticated;

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
  update public.drop_shadow_log
    set operator_pick_candidate_id = p_candidate_id,
        operator_notes = p_notes,
        operator_picked_at = now(),
        updated_at = now()
    where drop_date = p_drop_date;
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
