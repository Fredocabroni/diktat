// fact_check orchestrator handler. Wraps the existing sourced_factcheck
// ai-fabric task with: dedup cache, source HEAD-gate, verdict + sources
// persistence, retrieval_mode stamping, and the integrity contract (the
// prompt in @diktat/ai-fabric/prompts/fact-check).
//
// Pipeline:
//   1. Read target_claim_id from row.payload
//   2. fact_check_dedup_lookup → if hit, payload.outcome='cache_hit', done
//   3. Load claim text + context from fact_check_claims
//   4. Invoke fabric with FactCheckResultSchema + the integrity prompt
//   5. HEAD-check each returned source URL, stamp fetch_status
//   6. Derive retrieval_mode from result.provider ('perplexity' vs other)
//   7. fact_check_persist_verdict(claim_id, verdict_jsonb, sources_jsonb)
//   8. Stamp payload.outcome='verdict_recorded' + verdict_id + cost
//
// Streak break of the contract is NOT possible — the prompt forbids
// adjudicating value-laden claims and the DB CHECK forbids verdict=
// 'contested' without contested_reason. Schema + prompt + Zod refine
// are the three layers.

import {
  buildFactCheckUserPrompt,
  classifySourceQuality,
  deriveAuthoritative,
  FACT_CHECK_SYSTEM_PROMPT,
  FactCheckResultSchema,
  runHeadCheck,
  type FactCheckResult,
  type HeadCheckResult,
  type invoke as fabricInvokeType,
  type Provider,
  type ProviderEnv,
  type SourceQuality,
} from '@diktat/ai-fabric';

import { scrubMessage } from '@diktat/shared/alerts';

import type { JobHandler } from './scheduler.js';

/** Projection used for the per-task cap pre-check. Perplexity Sonar
 *  per-call cost under current pricing (~$1/M in, ~$1/M out, plus a
 *  per-request search fee ~$0.005) lands near $0.012-$0.015 for a
 *  typical claim; $0.02 leaves headroom for larger context + output.
 *  Sonnet-fallback path is cheaper (~$0.004-$0.008), so the projection
 *  is a worst-case bound. (CLAUDE.md pre-launch band.) */
const PROJECTED_USD_PER_CALL = 0.02;
const MAX_TOKENS = 2048;

interface FactCheckJobPayload {
  readonly claim_id?: string;
  readonly emitted_at?: string;
  /** When true, the orchestrator calls `fact_check_dedup_lookup` with
   *  `p_force_miss=true` so a stale `retrieval_mode='none'` /
   *  `authoritative=false` verdict does NOT short-circuit the fresh
   *  Perplexity-grounded redo. Used by `factcheck:recheck`. */
  readonly force_miss?: boolean;
}

interface ClaimRow {
  readonly id: string;
  readonly claim_text: string;
  readonly claim_context: string;
}

export interface FactCheckOrchestratorDeps {
  readonly invoke: typeof fabricInvokeType;
  readonly providerEnv: ProviderEnv;
  readonly fetch: typeof globalThis.fetch;
}

export const factCheckOrchestratorHandler: JobHandler = async (row, deps) => {
  const orchDeps = deps as typeof deps & Partial<FactCheckOrchestratorDeps>;
  if (!orchDeps.invoke || !orchDeps.providerEnv || !orchDeps.fetch) {
    throw new Error(
      'fact_check: handler requires invoke + providerEnv + fetch in deps (wire via SchedulerDeps).',
    );
  }
  const fabricInvoke = orchDeps.invoke;
  const providerEnv = orchDeps.providerEnv;
  const fetchFn = orchDeps.fetch;
  const payload = (row.payload ?? {}) as FactCheckJobPayload;
  const claimId = payload.claim_id;
  if (typeof claimId !== 'string' || claimId.length === 0) {
    throw new Error('fact_check: payload.claim_id is required on the job row');
  }

  const forceMiss = payload.force_miss === true;

  // 1. Dedup-check via the SQL function (no AI call when cached).
  //    `p_force_miss=true` is the recheck sweep's hook: the RPC returns
  //    `{hit:false}` even when a cached verdict exists so the fresh
  //    Perplexity-grounded run always lands.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dedup = (await (deps.supabase as any).rpc('fact_check_dedup_lookup', {
    p_claim_id: claimId,
    p_force_miss: forceMiss,
  })) as { data: { hit: boolean; verdict?: unknown } | null; error: { message: string } | null };
  if (dedup.error) {
    throw new Error(`fact_check_dedup_lookup RPC failed: ${scrubMessage(dedup.error.message)}`);
  }
  if (dedup.data?.hit === true) {
    await stampPayload(deps, row.id, { ...row.payload, outcome: 'cache_hit' });
    deps.logger.info({
      event: 'fact_check.cache_hit',
      jobId: row.id,
      claimId,
    });
    return;
  }

  // 2. Load claim text + context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claimRes = (await (deps.supabase as any)
    .from('fact_check_claims')
    .select('id, claim_text, claim_context')
    .eq('id', claimId)
    .maybeSingle()) as { data: ClaimRow | null; error: { message: string } | null };
  if (claimRes.error) {
    throw new Error(`fact_check: claim load failed: ${scrubMessage(claimRes.error.message)}`);
  }
  if (!claimRes.data) {
    // The claim row was deleted between enqueue and dispatch. Don't retry
    // forever — log and mark done so the spine doesn't dead-letter it.
    await stampPayload(deps, row.id, { ...row.payload, outcome: 'claim_missing' });
    deps.logger.warn({
      event: 'fact_check.claim_missing',
      jobId: row.id,
      claimId,
    });
    return;
  }
  const claim = claimRes.data;

  // 3. Invoke the fabric. The prompt is the integrity contract.
  const invokeResult = await fabricInvoke({
    task: 'sourced_factcheck',
    system: FACT_CHECK_SYSTEM_PROMPT,
    user: buildFactCheckUserPrompt({
      claimText: claim.claim_text,
      claimContext: claim.claim_context,
    }),
    schema: FactCheckResultSchema,
    env: providerEnv,
    projectedUsd: PROJECTED_USD_PER_CALL,
    maxTokens: MAX_TOKENS,
  });
  const verdict = invokeResult.output as FactCheckResult;
  const retrievalMode = providerToRetrievalMode(invokeResult.provider);

  // 4. HEAD-check every returned source URL AND classify by host.
  //    source_quality is server-derived — never trust the model's
  //    self-report of source quality (classifier is a host-check only,
  //    runs after HEAD-gate, see @diktat/ai-fabric/source-quality).
  const sources = await Promise.all(
    verdict.sources.map(async (src, idx) => {
      const head = await runHeadCheck(src.url, fetchFn);
      logHeadOutcome(deps, row.id, head);
      const sourceQuality: SourceQuality = classifySourceQuality(src.url);
      return {
        url: src.url,
        label: src.label,
        snippet: src.snippet,
        fetch_status: head.outcome,
        position: idx,
        source_quality: sourceQuality,
      };
    }),
  );

  // 5. Derive authoritative flag. False when the retrieval path was
  //    the Sonnet-from-memory fallback OR when every persisted source
  //    is `other` (CLAUDE.md pre-launch batch: "a supported/refuted
  //    verdict whose sources are all `other` must be persisted as
  //    non-authoritative"). The future UI uses this flag — not
  //    `retrieval_mode` directly — to decide whether to render a
  //    supported/refuted as authoritative; the factcheck:recheck
  //    sweep uses `authoritative=false AND verdict IN ('supported',
  //    'refuted')` to find rows that need a fresh Perplexity-grounded
  //    redo.
  const authoritative = deriveAuthoritative(
    retrievalMode,
    sources.map((s) => s.source_quality),
  );

  // 6. Persist verdict + sources atomically.
  const verdictJsonb = {
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    reason: verdict.reason,
    contested_reason: verdict.contested_reason,
    model: invokeResult.model,
    route: 'sourced_factcheck',
    retrieval_mode: retrievalMode,
    authoritative,
    cost_usd: invokeResult.usd,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persist = (await (deps.supabase as any).rpc('fact_check_persist_verdict', {
    p_claim_id: claimId,
    p_verdict: verdictJsonb,
    p_sources: sources,
  })) as { data: string | null; error: { message: string } | null };
  if (persist.error) {
    throw new Error(
      `fact_check_persist_verdict RPC failed: ${scrubMessage(persist.error.message)}`,
    );
  }
  const verdictId = persist.data;

  await stampPayload(deps, row.id, {
    ...row.payload,
    outcome: 'verdict_recorded',
    verdict_id: verdictId,
    verdict: verdict.verdict,
    retrieval_mode: retrievalMode,
    authoritative,
    cost_usd: invokeResult.usd,
  });

  deps.logger.info({
    event: 'fact_check.verdict_recorded',
    jobId: row.id,
    claimId,
    verdictId,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    retrievalMode,
    authoritative,
    model: invokeResult.model,
    sourceCount: sources.length,
    sourceQualities: sources.map((s) => s.source_quality),
    costUsd: invokeResult.usd,
  });
};

function providerToRetrievalMode(provider: Provider): 'none' | 'perplexity' {
  return provider === 'perplexity' ? 'perplexity' : 'none';
}

function logHeadOutcome(
  deps: { logger: { info: (o: object) => void; warn: (o: object) => void } },
  jobId: string,
  head: HeadCheckResult,
): void {
  const base = {
    event: 'fact_check.head_check',
    jobId,
    url: head.url,
    host: head.host,
    status: head.status,
    outcome: head.outcome,
  };
  if (head.outcome === 'pass' || head.outcome === 'skipped') {
    deps.logger.info(base);
  } else {
    deps.logger.warn(head.error ? { ...base, error: head.error } : base);
  }
}

async function stampPayload(
  deps: { supabase: unknown; logger: { error: (o: object) => void } },
  jobId: string,
  newPayload: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({ payload: newPayload })
    .eq('id', jobId);
  if (error) {
    // Throw — the dispatcher will retry, and the next attempt will be a
    // cache_hit (the verdict is already persisted). Surfaces via
    // scheduler.handler_failed.
    throw new Error(
      `fact_check: failed to stamp scheduled_jobs payload: ${scrubMessage(error.message)}`,
    );
  }
}
