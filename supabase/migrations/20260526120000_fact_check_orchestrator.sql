-- Migration: fact_check_orchestrator — PR 4.7
-- Up:
--   1. Three new tables under public:
--      - fact_check_claims      (dedup root; one row per unique claim)
--      - fact_check_verdicts    (per-attempt verdict; re-checks land as new rows)
--      - fact_check_sources     (one row per source surfaced per verdict)
--   2. Two SECURITY DEFINER SQL functions as the atomic write boundary:
--      - fact_check_dedup_lookup(p_claim_id, p_max_age_hours default 24)
--      - fact_check_persist_verdict(p_claim_id, p_verdict_jsonb, p_sources_jsonb)
--   3. RLS: read-all to authenticated on all three tables (transparency is
--      the contract; users need to see what was checked, the verdict, and
--      the sources). Writes service_role only.
--   4. No new cron entries. The Drop publish handler in PR 4.2 (and the
--      tRPC enqueue route in this PR) emit fact_check rows directly into
--      scheduled_jobs.
--
-- Down (reference, not auto-run):
--   drop function if exists public.fact_check_persist_verdict(uuid, jsonb, jsonb);
--   drop function if exists public.fact_check_dedup_lookup(uuid, int);
--   drop table if exists public.fact_check_sources;
--   drop table if exists public.fact_check_verdicts;
--   drop table if exists public.fact_check_claims;
--
-- Design context (full scope in PR 4.7 plan, contract in
-- packages/ai-fabric/src/prompts/fact-check.ts):
--   * Non-negotiable: MASTER_PLAN.md §1 + ADDICTION_ARCHITECTURE.md §2
--     "Community + AI fact-checks. Primary sources only — no MSM as
--     truth source."
--   * Verdict taxonomy: supported / refuted / mixed / unverifiable /
--     contested. The contested value is load-bearing — it is how the
--     orchestrator refuses to adjudicate value-laden political
--     disagreements as factual. The prompt enforces this.
--   * Empirical-disagreement case (reviewer-required): when credible
--     primary sources or expert analyses genuinely DISAGREE on a
--     factual/causal question, the model returns `mixed` (or
--     `unverifiable`). Prompt-level steering, no enum change.
--   * Grounding is a first-class field: retrieval_mode in
--     ('none' | 'perplexity'). Set to 'none' on Sonnet-from-memory
--     calls (no source retrieval). Set to 'perplexity' when the
--     Perplexity Sonar adapter is wired and runs the call. The future
--     UI refuses to render an ungrounded supported/refuted as
--     authoritative; the Perplexity wiring PR uses
--       where retrieval_mode='none' and verdict in ('supported','refuted')
--     to find exactly what to re-check.

begin;

-- ---------------------------------------------------------------------------
-- 1) fact_check_claims — dedup root.
-- ---------------------------------------------------------------------------

create table public.fact_check_claims (
  id            uuid primary key default gen_random_uuid(),
  claim_text    text not null check (char_length(claim_text) between 10 and 4000),
  -- Free-text descriptor: topic slug, debate seat tag, etc. Empty when the
  -- claim itself is the whole context (e.g. a Drop headline standalone).
  claim_context text not null default '',
  -- sha256( claim_text || '\n---\n' || claim_context ). The orchestrator's
  -- dedup key. Same hash → return the cached verdict (within the TTL).
  dedup_hash    text not null unique,
  ref_type      text not null check (ref_type in ('news_topic','debate_argument','manual')),
  ref_id        uuid,  -- nullable for 'manual'
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index fact_check_claims_ref_idx     on public.fact_check_claims (ref_type, ref_id);
create index fact_check_claims_created_idx on public.fact_check_claims (created_at desc);

alter table public.fact_check_claims enable row level security;
-- Transparency contract: anyone authenticated reads. Writes service_role.
create policy fact_check_claims_select_all on public.fact_check_claims
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2) fact_check_verdicts — per-attempt verdict history.
-- ---------------------------------------------------------------------------

create table public.fact_check_verdicts (
  id               uuid primary key default gen_random_uuid(),
  claim_id         uuid not null references public.fact_check_claims(id) on delete cascade,
  verdict          text not null check (verdict in
                     ('supported','refuted','mixed','unverifiable','contested')),
  confidence       numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  reason           text not null,
  -- Required when verdict='contested'. Short, neutral summary of the
  -- disagreement axes. The prompt forbids picking a side.
  contested_reason text,
  -- e.g. 'anthropic_sonnet_46', 'perplexity_sonar'. Stamped from the
  -- fabric InvokeResult.model.
  model            text not null,
  -- 'sourced_factcheck' today; 'grok_live' when the live route lands.
  route            text not null check (route in ('sourced_factcheck','grok_live')),
  -- Grounding mode — first-class, not implicit in snippet=null. The
  -- future UI uses this to refuse to render an ungrounded
  -- supported/refuted as authoritative.
  retrieval_mode   text not null default 'none' check (retrieval_mode in ('none','perplexity')),
  cost_usd         numeric(10,6),
  settled_at       timestamptz not null default now(),
  -- Row-level integrity: contested verdicts MUST carry a reason.
  check (verdict <> 'contested' or contested_reason is not null)
);
create index fact_check_verdicts_claim_idx          on public.fact_check_verdicts (claim_id, settled_at desc);
create index fact_check_verdicts_settled_idx        on public.fact_check_verdicts (settled_at desc);
-- The Perplexity wiring PR will use this index to find ungrounded
-- supported/refuted verdicts that need a re-check.
create index fact_check_verdicts_retrieval_mode_idx on public.fact_check_verdicts (retrieval_mode, verdict);

alter table public.fact_check_verdicts enable row level security;
create policy fact_check_verdicts_select_all on public.fact_check_verdicts
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3) fact_check_sources — sources surfaced per verdict.
-- ---------------------------------------------------------------------------

create table public.fact_check_sources (
  id            uuid primary key default gen_random_uuid(),
  verdict_id    uuid not null references public.fact_check_verdicts(id) on delete cascade,
  url           text not null,
  label         text not null check (char_length(label) between 1 and 200),
  -- HEAD-gate outcome from packages/ai-fabric/src/head-gate.ts.
  --   pass            — 2xx
  --   advisory_pass   — 403/405/429/5xx (host answered, not dead)
  --   reject          — 404/410 / DNS / connection refused / timeout
  --   skipped         — HEAD probe deliberately not run (e.g. whitelisted host)
  fetch_status  text not null check (fetch_status in ('pass','advisory_pass','reject','skipped')),
  -- Perplexity populates this with the retrieved excerpt. Stays null on
  -- the Sonnet-from-memory path (retrieval_mode='none' on the parent
  -- verdict). The future UI can render a "named from memory" badge when
  -- snippet is null AND parent verdict's retrieval_mode='none'.
  snippet       text check (snippet is null or char_length(snippet) <= 2000),
  position      smallint not null default 0,
  created_at    timestamptz not null default now()
);
create index fact_check_sources_verdict_idx on public.fact_check_sources (verdict_id, position);

alter table public.fact_check_sources enable row level security;
create policy fact_check_sources_select_all on public.fact_check_sources
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 4) fact_check_dedup_lookup — cache check.
-- ---------------------------------------------------------------------------
-- Returns the most-recent verdict for a claim_id IF settled within
-- p_max_age_hours. Default 24h. Returning the full row as jsonb keeps the
-- handler thin — no second roundtrip to load the verdict + sources.

create or replace function public.fact_check_dedup_lookup(
  p_claim_id uuid,
  p_max_age_hours int default 24
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
    'position', position
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
      'cost_usd', v_verdict_row.cost_usd,
      'settled_at', v_verdict_row.settled_at,
      'sources', v_sources_json
    )
  );
end;
$$;

revoke all on function public.fact_check_dedup_lookup(uuid, int) from public;
grant execute on function public.fact_check_dedup_lookup(uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- 5) fact_check_persist_verdict — atomic verdict + sources insert.
-- ---------------------------------------------------------------------------
-- p_verdict shape (jsonb):
--   {
--     verdict: 'supported'|'refuted'|'mixed'|'unverifiable'|'contested',
--     confidence: number 0..1,
--     reason: text,
--     contested_reason: text|null,
--     model: text,
--     route: 'sourced_factcheck'|'grok_live',
--     retrieval_mode: 'none'|'perplexity',
--     cost_usd: number|null
--   }
-- p_sources shape (jsonb array):
--   [{ url, label, fetch_status, snippet|null, position }]
--
-- Returns the new verdict_id. Rolls back the entire batch on any failure
-- so the verdict and its sources are an atomic unit.

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
    nullif(p_verdict->>'cost_usd', '')::numeric
  )
  returning id into v_verdict_id;

  if p_sources is not null and jsonb_typeof(p_sources) = 'array' then
    for v_source in select * from jsonb_array_elements(p_sources)
    loop
      insert into public.fact_check_sources (
        verdict_id, url, label, fetch_status, snippet, position
      )
      values (
        v_verdict_id,
        v_source->>'url',
        v_source->>'label',
        coalesce(v_source->>'fetch_status', 'skipped'),
        nullif(v_source->>'snippet', ''),
        coalesce((v_source->>'position')::int, v_pos)
      );
      v_pos := v_pos + 1;
    end loop;
  end if;

  return v_verdict_id;
end;
$$;

revoke all on function public.fact_check_persist_verdict(uuid, jsonb, jsonb) from public;
grant execute on function public.fact_check_persist_verdict(uuid, jsonb, jsonb) to service_role;

commit;
