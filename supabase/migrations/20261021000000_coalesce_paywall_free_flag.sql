-- Migration: clarity-only — coalesce(p_is_paywall_free_preferred, false)
-- in upsert_gdelt_event_mention, so the three-valued-logic AND behaves
-- as the operator reads it.
--
-- #215 INFO (post-#221 security review): the function body derives
-- `v_is_paywall_free_news := p_is_paywall_free_preferred and
-- p_outlet_type = 'news'`. In SQL three-valued logic, when
-- `p_outlet_type` is NULL (primary / direct mentions), the expression
-- evaluates to NULL — not FALSE. A plpgsql boolean variable holding
-- NULL is treated as falsy in `CASE WHEN`, so `best_news_url` is
-- correctly NOT set in that path. Behavior is already correct, but
-- the AND relies on three-valued logic rather than reading
-- explicitly.
--
-- Fix: `coalesce(p_is_paywall_free_preferred, false) AND
-- p_outlet_type = 'news'` makes the intent explicit without changing
-- behavior. (p_is_paywall_free_preferred is already defaulted to
-- false by the function signature from 20261017000000, but a caller
-- that explicitly passes NULL would also now short-circuit at the
-- coalesce rather than through the AND's NULL path.)
--
-- CREATE OR REPLACE preserves grants per Postgres docs, but the
-- migration re-applies the full grant block (revoke all from public /
-- anon / authenticated; grant execute to service_role) for symmetry
-- with migration 20261017000000's convention. Function body is
-- otherwise unchanged.
--
-- Prod max migration version confirmed read-only pre-apply:
--   20261018000000. New migration 20261021000000 sorts strictly after
--   the two queued migrations (20261019000000 PR C,
--   20261020000000 PR #231).
--
-- Up:
--   CREATE OR REPLACE FUNCTION public.upsert_gdelt_event_mention(...)
--     — same signature, same body, with coalesce() on the paywall-
--       free flag inside v_is_paywall_free_news.
--   REVOKE / GRANT re-applied for symmetry.
--
-- Down:
--   Reinstate the pre-coalesce form:
--     v_is_paywall_free_news boolean := p_is_paywall_free_preferred
--                                      and p_outlet_type = 'news';
--   via another CREATE OR REPLACE. Behavior-equivalent on all live
--   callers; this migration is a readability/robustness tightening,
--   not a behavior change, so Down is cosmetic and reversible.

begin;

create or replace function public.upsert_gdelt_event_mention(
  p_global_event_id text,
  p_url text,
  p_host text,
  p_evidence_tier public.news_evidence_tier,
  p_outlet_lean text default null,
  p_outlet_group public.news_outlet_group default null,
  p_outlet_type public.news_outlet_type default null,
  p_is_paywall_free_preferred boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_primary boolean := p_evidence_tier in ('primary', 'direct');
  -- #215 INFO: coalesce the flag so an explicit-NULL caller behaves
  -- the same as the default-FALSE caller. The AND's NULL branch
  -- (when p_outlet_type is NULL) is still correct but less explicit;
  -- the coalesce reads the way the operator reasons about it.
  v_is_paywall_free_news boolean := coalesce(p_is_paywall_free_preferred, false)
    and p_outlet_type = 'news';
begin
  -- Step 1 — cluster row upsert with first-seen-wins coalesce.
  insert into public.gdelt_event_cluster as c (
    global_event_id,
    first_seen_at,
    last_seen_at,
    updated_at,
    primary_url,
    primary_host,
    primary_tier,
    best_news_url,
    best_news_host
  ) values (
    p_global_event_id,
    now(),
    now(),
    now(),
    case when v_is_primary then p_url else null end,
    case when v_is_primary then p_host else null end,
    case when v_is_primary then p_evidence_tier else null end,
    case when v_is_paywall_free_news then p_url else null end,
    case when v_is_paywall_free_news then p_host else null end
  )
  on conflict (global_event_id) do update set
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at,
    primary_url = coalesce(c.primary_url, excluded.primary_url),
    primary_host = coalesce(c.primary_host, excluded.primary_host),
    primary_tier = coalesce(c.primary_tier, excluded.primary_tier),
    best_news_url = coalesce(c.best_news_url, excluded.best_news_url),
    best_news_host = coalesce(c.best_news_host, excluded.best_news_host);

  -- Step 2 — outlet row insert, cross-tick dedup via composite PK.
  insert into public.gdelt_event_cluster_outlet (
    global_event_id,
    host,
    outlet_lean,
    outlet_group,
    outlet_type,
    url
  ) values (
    p_global_event_id,
    p_host,
    p_outlet_lean,
    p_outlet_group,
    p_outlet_type,
    p_url
  )
  on conflict (global_event_id, host) do nothing;
end;
$$;

revoke all on function public.upsert_gdelt_event_mention(text, text, text, public.news_evidence_tier, text, public.news_outlet_group, public.news_outlet_type, boolean) from public;
revoke all on function public.upsert_gdelt_event_mention(text, text, text, public.news_evidence_tier, text, public.news_outlet_group, public.news_outlet_type, boolean) from anon;
revoke all on function public.upsert_gdelt_event_mention(text, text, text, public.news_evidence_tier, text, public.news_outlet_group, public.news_outlet_type, boolean) from authenticated;
grant execute on function public.upsert_gdelt_event_mention(text, text, text, public.news_evidence_tier, text, public.news_outlet_group, public.news_outlet_type, boolean) to service_role;

commit;
