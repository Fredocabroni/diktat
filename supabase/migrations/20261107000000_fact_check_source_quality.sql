-- Migration: fact-check source grounding support.
--
-- Adds:
--   - `fact_check_sources.source_quality` ∈ {primary, allowlisted, other}
--     — stamped by the orchestrator after HEAD-gate from the URL host.
--     `.gov` / `.mil` → primary; news-outlets.ts allowlisted → allowlisted;
--     everything else → other.
--   - `fact_check_verdicts.authoritative` boolean — false when
--     `retrieval_mode='none'` (model answered from memory) OR when every
--     source in the verdict is `source_quality='other'` even on a
--     Perplexity call. The future verdict-rendering UI refuses to render
--     a `supported`/`refuted` as authoritative when this flag is false;
--     the `factcheck:recheck` sweep script queues those verdicts for a
--     Perplexity-grounded redo.
--   - Partial index for the sweep.
--   - `fact_check_dedup_lookup` gets a `p_force_miss boolean default false`
--     param. When true, the lookup returns `{hit: false}` even if a cached
--     verdict exists — used by the recheck script and the orchestrator
--     when the scheduled_jobs payload carries `force_miss=true`.
--   - `fact_check_persist_verdict` body updated to extract the new
--     `authoritative` field from `p_verdict` and the new `source_quality`
--     field from each `p_sources` element. Signature unchanged; existing
--     callers that omit the new keys keep working via the column defaults.
--
-- Up:
--   alter fact_check_sources add source_quality;
--   alter fact_check_verdicts add authoritative;
--   create partial index for the recheck sweep;
--   drop + create fact_check_dedup_lookup (signature change);
--   create or replace fact_check_persist_verdict (signature stable).
--
-- Down:
--   drop function fact_check_dedup_lookup(uuid, int, boolean);
--   create function fact_check_dedup_lookup(uuid, int) with the prior body;
--   create or replace fact_check_persist_verdict without the new fields;
--   drop index fact_check_verdicts_recheck_idx;
--   alter fact_check_verdicts drop authoritative;
--   alter fact_check_sources drop source_quality;

begin;

alter table public.fact_check_sources
  add column source_quality text not null default 'other'
  check (source_quality in ('primary', 'allowlisted', 'other'));

comment on column public.fact_check_sources.source_quality is
  'Server-derived classification of the source host at persist time. '
  'primary = .gov/.mil/official primary host; allowlisted = news-outlets.ts '
  'allowlist (reputable-tier); other = anything else. Stamped by the '
  'fact-check orchestrator after HEAD-gate; never trusted from the model.';

alter table public.fact_check_verdicts
  add column authoritative boolean not null default true;

comment on column public.fact_check_verdicts.authoritative is
  'False when retrieval_mode=''none'' (model from memory) OR when every '
  'persisted source on the verdict is source_quality=''other''. The UI '
  'refuses to render supported/refuted as authoritative when false; the '
  'factcheck:recheck sweep requeues these claims for a Perplexity-grounded '
  'redo.';

-- Partial index for the sweep. Only indexes the authoritative=false +
-- supported/refuted rows — the recheck target set. Keeps the index tiny.
create index fact_check_verdicts_recheck_idx
  on public.fact_check_verdicts (settled_at desc)
  where authoritative = false
    and verdict in ('supported', 'refuted');

-- ---------------------------------------------------------------------------
-- fact_check_dedup_lookup — signature changes (adds p_force_miss).
-- ---------------------------------------------------------------------------
drop function if exists public.fact_check_dedup_lookup(uuid, int);

create function public.fact_check_dedup_lookup(
  p_claim_id      uuid,
  p_max_age_hours int default 24,
  p_force_miss    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verdict_row public.fact_check_verdicts%rowtype;
  v_sources_json jsonb;
begin
  -- Short-circuit: a recheck caller (factcheck:recheck script or an
  -- orchestrator run whose scheduled_jobs payload carries
  -- `force_miss=true`) wants to redo the AI call even if a cached
  -- verdict exists. Return the no-hit shape without reading the row.
  if p_force_miss then
    return jsonb_build_object('hit', false);
  end if;

  select * into v_verdict_row
  from public.fact_check_verdicts
  where claim_id = p_claim_id
    and settled_at >= now() - (p_max_age_hours || ' hours')::interval
  order by settled_at desc
  limit 1;

  if not found then
    return jsonb_build_object('hit', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'url', url,
    'label', label,
    'fetch_status', fetch_status,
    'snippet', snippet,
    'position', position,
    'source_quality', source_quality
  ) order by position), '[]'::jsonb)
  into v_sources_json
  from public.fact_check_sources
  where verdict_id = v_verdict_row.id;

  return jsonb_build_object(
    'hit', true,
    'verdict', jsonb_build_object(
      'id', v_verdict_row.id,
      'claim_id', v_verdict_row.claim_id,
      'verdict', v_verdict_row.verdict,
      'confidence', v_verdict_row.confidence,
      'reason', v_verdict_row.reason,
      'contested_reason', v_verdict_row.contested_reason,
      'model', v_verdict_row.model,
      'route', v_verdict_row.route,
      'retrieval_mode', v_verdict_row.retrieval_mode,
      'authoritative', v_verdict_row.authoritative,
      'cost_usd', v_verdict_row.cost_usd,
      'settled_at', v_verdict_row.settled_at,
      'sources', v_sources_json
    )
  );
end;
$$;

revoke all on function public.fact_check_dedup_lookup(uuid, int, boolean) from public;
grant execute on function public.fact_check_dedup_lookup(uuid, int, boolean) to service_role;

comment on function public.fact_check_dedup_lookup is
  'Returns {hit:true, verdict:{…}} for a cached verdict within the '
  'p_max_age_hours window, or {hit:false}. p_force_miss=true always '
  'returns {hit:false} — used by the factcheck:recheck sweep so a stale '
  'retrieval_mode=''none'' / authoritative=false verdict does NOT short-'
  'circuit the fresh Perplexity-grounded redo.';

-- ---------------------------------------------------------------------------
-- fact_check_persist_verdict — body extracts authoritative + source_quality.
-- Signature (uuid, jsonb, jsonb) unchanged; existing callers keep working.
-- ---------------------------------------------------------------------------
create or replace function public.fact_check_persist_verdict(
  p_claim_id uuid,
  p_verdict  jsonb,
  p_sources  jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verdict_id uuid;
  v_source jsonb;
  v_pos int := 0;
  v_source_quality text;
begin
  if p_verdict is null or jsonb_typeof(p_verdict) <> 'object' then
    raise exception 'fact_check_persist_verdict: p_verdict must be a jsonb object';
  end if;

  insert into public.fact_check_verdicts (
    claim_id,
    verdict,
    confidence,
    reason,
    contested_reason,
    model,
    route,
    retrieval_mode,
    authoritative,
    cost_usd
  )
  values (
    p_claim_id,
    p_verdict->>'verdict',
    (p_verdict->>'confidence')::numeric,
    p_verdict->>'reason',
    p_verdict->>'contested_reason',
    p_verdict->>'model',
    coalesce(p_verdict->>'route', 'sourced_factcheck'),
    coalesce(p_verdict->>'retrieval_mode', 'none'),
    -- Default true preserves existing-caller behaviour (orchestrator rows
    -- written before this migration applied set authoritative=true by
    -- default). New callers that stamp `authoritative=false` on a
    -- non-grounded or all-'other'-sources verdict land as false.
    coalesce((p_verdict->>'authoritative')::boolean, true),
    nullif(p_verdict->>'cost_usd', '')::numeric
  )
  returning id into v_verdict_id;

  if p_sources is not null and jsonb_typeof(p_sources) = 'array' then
    for v_source in select * from jsonb_array_elements(p_sources)
    loop
      -- source_quality: default to 'other' when absent (back-compat with
      -- any pre-migration caller) OR when a bogus value sneaks in — the
      -- CHECK constraint on the column would otherwise fail the entire
      -- insert and lose the whole verdict.
      v_source_quality := coalesce(v_source->>'source_quality', 'other');
      if v_source_quality not in ('primary', 'allowlisted', 'other') then
        v_source_quality := 'other';
      end if;

      insert into public.fact_check_sources (
        verdict_id, url, label, fetch_status, snippet, position, source_quality
      )
      values (
        v_verdict_id,
        v_source->>'url',
        v_source->>'label',
        coalesce(v_source->>'fetch_status', 'skipped'),
        nullif(v_source->>'snippet', ''),
        coalesce((v_source->>'position')::int, v_pos),
        v_source_quality
      );
      v_pos := v_pos + 1;
    end loop;
  end if;

  return v_verdict_id;
end;
$$;

commit;
