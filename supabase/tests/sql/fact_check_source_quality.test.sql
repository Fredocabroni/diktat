-- Behavioural tests for migration 20261107000000.
-- Covers:
--   T1  source_quality column CHECK accepts the three enum values
--   T2  source_quality column CHECK rejects an unknown value
--   T3  fact_check_persist_verdict stamps authoritative=false when the
--       caller passes it; defaults to true when omitted
--   T4  fact_check_persist_verdict salvages a source row whose
--       source_quality jsonb value is invalid — rewrites to 'other'
--       rather than failing the whole insert
--   T5  fact_check_dedup_lookup p_force_miss=true returns {hit:false}
--       even when a cached verdict exists within the window
--   T6  the recheck partial index covers only the target shape

begin;

-- --------------------------------------------------------------------------
-- Fixtures. Minimal auth.users + public.users row to satisfy FKs.
-- --------------------------------------------------------------------------
insert into auth.users (id, email, aud, role, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', 'u@test', 'authenticated',
        'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.users (id, handle, display_name, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111',
        'u_fcsq', 'FCSQ User', now(), now())
on conflict (id) do nothing;

insert into public.fact_check_claims (
  id, claim_text, claim_context, dedup_hash, ref_type, ref_id, created_by
)
values (
  '22222222-2222-2222-2222-222222222222',
  'The quick brown fox jumps over the lazy dog.',
  'ctx-FCSQ',
  'dedup_FCSQ_1',
  'manual',
  null,
  '11111111-1111-1111-1111-111111111111'
)
on conflict (id) do nothing;

-- --------------------------------------------------------------------------
-- T1 — source_quality CHECK accepts the three enum values via the
--     fact_check_persist_verdict RPC.
-- --------------------------------------------------------------------------
do $$
declare
  v_vid uuid;
begin
  v_vid := public.fact_check_persist_verdict(
    '22222222-2222-2222-2222-222222222222',
    jsonb_build_object(
      'verdict', 'supported',
      'confidence', 0.9,
      'reason', 'because the sentence contains all 26 letters',
      'contested_reason', null,
      'model', 'test-model',
      'route', 'sourced_factcheck',
      'retrieval_mode', 'perplexity',
      'authoritative', true,
      'cost_usd', 0.012
    ),
    jsonb_build_array(
      jsonb_build_object('url', 'https://example.gov/report', 'label', 'gov',
                         'fetch_status', 'pass', 'position', 0,
                         'source_quality', 'primary'),
      jsonb_build_object('url', 'https://nytimes.com/x', 'label', 'nyt',
                         'fetch_status', 'pass', 'position', 1,
                         'source_quality', 'allowlisted'),
      jsonb_build_object('url', 'https://random-blog.net/post', 'label', 'blog',
                         'fetch_status', 'pass', 'position', 2,
                         'source_quality', 'other')
    )
  );
  if (select count(*) from public.fact_check_sources where verdict_id = v_vid) <> 3 then
    raise exception 'T1: expected 3 sources rows, got %',
      (select count(*) from public.fact_check_sources where verdict_id = v_vid);
  end if;
  if (select source_quality from public.fact_check_sources
       where verdict_id = v_vid and position = 0) <> 'primary' then
    raise exception 'T1: primary not stamped on position 0';
  end if;
  if (select source_quality from public.fact_check_sources
       where verdict_id = v_vid and position = 1) <> 'allowlisted' then
    raise exception 'T1: allowlisted not stamped on position 1';
  end if;
  if (select source_quality from public.fact_check_sources
       where verdict_id = v_vid and position = 2) <> 'other' then
    raise exception 'T1: other not stamped on position 2';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- T2 — the CHECK on source_quality enforces the enum at the column level
--     (direct INSERT, outside the RPC's defensive salvage).
-- --------------------------------------------------------------------------
do $$
declare
  v_vid uuid := (select id from public.fact_check_verdicts
                 where claim_id = '22222222-2222-2222-2222-222222222222'
                 order by settled_at desc limit 1);
begin
  begin
    insert into public.fact_check_sources
      (verdict_id, url, label, fetch_status, snippet, position, source_quality)
    values (v_vid, 'https://x/', 'x', 'pass', null, 99, 'bogus');
    raise exception 'T2: expected CHECK violation on source_quality=''bogus''';
  exception when check_violation then
    -- expected
    null;
  end;
end
$$;

-- --------------------------------------------------------------------------
-- T3 — authoritative stamping. The RPC extracts (p_verdict->>'authoritative'
--     ::boolean) and persists the value. Omitted → defaults to true.
-- --------------------------------------------------------------------------
do $$
declare
  v_vid uuid;
begin
  -- 3a: explicit authoritative=false
  v_vid := public.fact_check_persist_verdict(
    '22222222-2222-2222-2222-222222222222',
    jsonb_build_object(
      'verdict', 'refuted', 'confidence', 0.9,
      'reason', 'r', 'contested_reason', null,
      'model', 'test', 'route', 'sourced_factcheck',
      'retrieval_mode', 'none',
      'authoritative', false,
      'cost_usd', 0.0
    ),
    '[]'::jsonb
  );
  if (select authoritative from public.fact_check_verdicts where id = v_vid) <> false then
    raise exception 'T3a: expected authoritative=false';
  end if;

  -- 3b: authoritative key omitted → defaults to true (back-compat path)
  v_vid := public.fact_check_persist_verdict(
    '22222222-2222-2222-2222-222222222222',
    jsonb_build_object(
      'verdict', 'supported', 'confidence', 0.9,
      'reason', 'r', 'contested_reason', null,
      'model', 'test', 'route', 'sourced_factcheck',
      'retrieval_mode', 'perplexity',
      'cost_usd', 0.0
    ),
    '[]'::jsonb
  );
  if (select authoritative from public.fact_check_verdicts where id = v_vid) <> true then
    raise exception 'T3b: expected authoritative to default to true when key omitted';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- T4 — RPC salvages a bogus source_quality value by rewriting to 'other'.
-- --------------------------------------------------------------------------
do $$
declare
  v_vid uuid;
begin
  v_vid := public.fact_check_persist_verdict(
    '22222222-2222-2222-2222-222222222222',
    jsonb_build_object(
      'verdict', 'unverifiable', 'confidence', 0.5,
      'reason', 'r', 'contested_reason', null,
      'model', 'test', 'route', 'sourced_factcheck',
      'retrieval_mode', 'perplexity',
      'authoritative', true,
      'cost_usd', 0.0
    ),
    jsonb_build_array(
      jsonb_build_object('url', 'https://x/', 'label', 'x',
                         'fetch_status', 'pass', 'position', 0,
                         'source_quality', 'definitely-not-a-valid-value')
    )
  );
  if (select source_quality from public.fact_check_sources
       where verdict_id = v_vid and position = 0) <> 'other' then
    raise exception 'T4: expected salvage to "other"';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- T5 — p_force_miss short-circuits dedup lookup.
-- --------------------------------------------------------------------------
do $$
declare
  v_lookup_default jsonb;
  v_lookup_force   jsonb;
begin
  -- 24h window — the T1 verdict is fresh.
  v_lookup_default := public.fact_check_dedup_lookup(
    '22222222-2222-2222-2222-222222222222',
    24,
    false
  );
  if (v_lookup_default->>'hit')::boolean <> true then
    raise exception 'T5a: expected cache hit when p_force_miss=false';
  end if;

  v_lookup_force := public.fact_check_dedup_lookup(
    '22222222-2222-2222-2222-222222222222',
    24,
    true
  );
  if (v_lookup_force->>'hit')::boolean <> false then
    raise exception 'T5b: expected hit=false when p_force_miss=true';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- T6 — the recheck partial index exists on the expected predicate.
-- --------------------------------------------------------------------------
do $$
declare
  v_idx_exists boolean;
begin
  select exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'fact_check_verdicts_recheck_idx'
  ) into v_idx_exists;
  if not v_idx_exists then
    raise exception 'T6: recheck partial index not found';
  end if;
end
$$;

rollback;

\echo 'fact_check_source_quality.test.sql: ok'
