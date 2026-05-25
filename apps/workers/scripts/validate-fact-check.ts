// End-to-end validation for the PR 4.7 fact-check orchestrator. Runs
// the orchestrator handler against the live dev DB AND the live AI
// fabric. Each invocation costs ~$0.003 (Sonnet 4.6) — multiple
// scenarios total well under $0.10. Run manually, not in CI.
//
// Run:
//   (set -a; . ./.env.local; set +a;
//      pnpm --filter=@diktat/workers exec tsx scripts/validate-fact-check.ts)
//
// Hard guards:
//   - Aborts unless SUPABASE_URL targets the dev project ref.
//   - Cleans up all created claims (cascades verdicts + sources) and
//     scheduled_jobs rows in a finally block.
//
// Scenarios:
//   1. Value-laden claim → verdict='contested' + contested_reason set
//      (the §2 neutrality contract; the load-bearing assertion).
//   2. Re-run the same claim → orchestrator returns cache_hit, no new
//      verdict row. (Dedup correctness.)
//   3. Empirical-disagreement claim → verdict in (mixed, unverifiable);
//      MUST NOT be supported/refuted (the reviewer-required "never
//      manufacture confidence" steering — verified empirically).
//   4. retrieval_mode='none' when Sonnet is the responding model.

import { createHash, randomUUID } from 'node:crypto';

import { loadEnv } from '../src/env.js';
import { factCheckOrchestratorHandler } from '../src/jobs/fact-check-orchestrator.js';
import type { ScheduledJobRow } from '../src/jobs/scheduler.js';
import { buildServiceClient, type ServiceClient } from '../src/supabase.js';
import { invoke as fabricInvoke, type ProviderEnv } from '@diktat/ai-fabric';

const DEV_PROJECT_REF = 'immzaaysjlftyijwdsrm';

let totalPassed = 0;
let totalFailed = 0;

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    totalPassed += 1;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    totalFailed += 1;
  }
}

function dedupHash(claimText: string, claimContext: string): string {
  return createHash('sha256').update(`${claimText}\n---\n${claimContext}`).digest('hex');
}

interface SyntheticJobRow {
  id: string;
  payload: Record<string, unknown>;
}

async function enqueueClaim(
  supabase: ServiceClient,
  input: {
    claimText: string;
    claimContext?: string;
    refType?: 'manual' | 'news_topic' | 'debate_argument';
    refId?: string | null;
    createdBy?: string | null;
  },
): Promise<{ claimId: string; jobRow: SyntheticJobRow }> {
  const claimContext = input.claimContext ?? '';
  const hash = dedupHash(input.claimText, claimContext);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from('fact_check_claims').upsert(
    {
      claim_text: input.claimText,
      claim_context: claimContext,
      dedup_hash: hash,
      ref_type: input.refType ?? 'manual',
      ref_id: input.refId ?? null,
      created_by: input.createdBy ?? null,
    },
    { onConflict: 'dedup_hash', ignoreDuplicates: true },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claim } = (await (supabase as any)
    .from('fact_check_claims')
    .select('id')
    .eq('dedup_hash', hash)
    .single()) as { data: { id: string } };

  // INSERT a real scheduled_jobs row so the handler's terminal
  // stampPayload UPDATE finds a target. Per-invocation idempotency_key
  // (random UUID suffix) so two calls within the same test don't
  // collide on the (job_type, idempotency_key) partial-unique index.
  const idempotencyKey = `validate-${randomUUID()}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: jobRow, error: jobErr } = (await (supabase as any)
    .from('scheduled_jobs')
    .insert({
      job_type: 'fact_check',
      idempotency_key: idempotencyKey,
      payload: { claim_id: claim.id, enqueued_at: new Date().toISOString() },
      status: 'processing',
      attempts: 1,
      locked_at: new Date().toISOString(),
      locked_by: 'validate-fact-check',
    })
    .select('id, payload')
    .single()) as {
    data: { id: string; payload: Record<string, unknown> } | null;
    error: { message: string } | null;
  };
  if (jobErr || !jobRow) {
    throw new Error(`failed to insert scheduled_jobs row: ${jobErr?.message}`);
  }

  return {
    claimId: claim.id,
    jobRow: { id: jobRow.id, payload: jobRow.payload },
  };
}

function jobAsScheduledRow(synth: SyntheticJobRow): ScheduledJobRow {
  return {
    id: synth.id,
    job_type: 'fact_check',
    idempotency_key: 'validate-script',
    target_user_id: null,
    payload: synth.payload,
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'validate-fact-check',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

interface VerdictRow {
  id: string;
  claim_id: string;
  verdict: string;
  confidence: number;
  reason: string;
  contested_reason: string | null;
  model: string;
  route: string;
  retrieval_mode: string;
  cost_usd: number | null;
  settled_at: string;
}

async function latestVerdict(supabase: ServiceClient, claimId: string): Promise<VerdictRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = (await (supabase as any)
    .from('fact_check_verdicts')
    .select('*')
    .eq('claim_id', claimId)
    .order('settled_at', { ascending: false })
    .limit(1)
    .maybeSingle()) as { data: VerdictRow | null };
  return data;
}

async function verdictCount(supabase: ServiceClient, claimId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = (await (supabase as any)
    .from('fact_check_verdicts')
    .select('id', { count: 'exact', head: true })
    .eq('claim_id', claimId)) as { count: number };
  return count ?? 0;
}

function buildLogger(): {
  info: (o: object) => void;
  warn: (o: object) => void;
  error: (o: object) => void;
  debug: (o: object) => void;
} {
  return {
    info: (o) => console.log('  log.info', JSON.stringify(o)),
    warn: (o) => console.warn('  log.warn', JSON.stringify(o)),
    error: (o) => console.error('  log.error', JSON.stringify(o)),
    debug: () => {},
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL.includes(DEV_PROJECT_REF)) {
    throw new Error(`refusing to run: SUPABASE_URL does not target dev project ${DEV_PROJECT_REF}`);
  }
  const supabase = buildServiceClient(env);
  const providerEnv: ProviderEnv = {
    xaiAvailable: Boolean(process.env.XAI_API_KEY),
    perplexityAvailable: Boolean(process.env.PERPLEXITY_API_KEY),
  };
  console.log(
    `\nprovider env: xai=${providerEnv.xaiAvailable} perplexity=${providerEnv.perplexityAvailable}`,
  );
  console.log(`(perplexity=false means Sonnet 4.6 from-memory — retrieval_mode will be 'none')\n`);

  const logger = buildLogger();
  const cleanup: string[] = []; // claim ids
  const cleanupJobs: string[] = []; // scheduled_jobs row ids

  try {
    // ---------------------------------------------------------------------
    console.log('--- TEST 1: value-laden claim → contested ---');
    // ---------------------------------------------------------------------
    const valueLaden = await enqueueClaim(supabase, {
      claimText:
        'A policy of universal basic income is the morally right approach for the United States.',
      claimContext: 'PR 4.7 validation — value-laden',
    });
    cleanup.push(valueLaden.claimId);
    cleanupJobs.push(valueLaden.jobRow.id);

    await factCheckOrchestratorHandler(jobAsScheduledRow(valueLaden.jobRow), {
      supabase,
      logger: logger as never,
      invoke: fabricInvoke,
      providerEnv,
      fetch: globalThis.fetch,
    });

    const v1 = await latestVerdict(supabase, valueLaden.claimId);
    assert('verdict row was persisted', v1 !== null);
    assert(
      `verdict === 'contested' (value-laden claim)`,
      v1?.verdict === 'contested',
      `got ${v1?.verdict}`,
    );
    assert(
      `contested_reason is populated when verdict='contested'`,
      v1?.contested_reason != null && v1.contested_reason.length > 0,
      `got ${JSON.stringify(v1?.contested_reason)}`,
    );
    assert(
      `retrieval_mode='none' on the Sonnet-from-memory path`,
      v1?.retrieval_mode === 'none',
      `got ${v1?.retrieval_mode}`,
    );
    assert(`route='sourced_factcheck'`, v1?.route === 'sourced_factcheck');
    assert(`cost_usd is positive (call was billed)`, (v1?.cost_usd ?? 0) > 0);

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 2: re-run same claim → cache hit, no new verdict ---');
    // ---------------------------------------------------------------------
    const beforeCount = await verdictCount(supabase, valueLaden.claimId);
    await factCheckOrchestratorHandler(jobAsScheduledRow(valueLaden.jobRow), {
      supabase,
      logger: logger as never,
      invoke: fabricInvoke,
      providerEnv,
      fetch: globalThis.fetch,
    });
    const afterCount = await verdictCount(supabase, valueLaden.claimId);
    assert(
      `verdict count unchanged after re-run (cache hit)`,
      afterCount === beforeCount,
      `was ${beforeCount}, now ${afterCount}`,
    );

    // ---------------------------------------------------------------------
    console.log('\n--- TEST 3: empirical-disagreement claim → mixed/unverifiable ---');
    // ---------------------------------------------------------------------
    // A claim where the credible economic literature is genuinely split.
    // The prompt's REQUIRED steering says: when credible primary sources
    // or expert analyses genuinely DISAGREE on the factual/causal
    // question, return 'mixed' (or 'unverifiable'). Never manufacture
    // confidence.
    const disputedEmpirics = await enqueueClaim(supabase, {
      claimText:
        'Raising the federal minimum wage to $15 per hour causes a measurable decrease in low-wage employment.',
      claimContext: 'PR 4.7 validation — disputed empirics (credible economists genuinely split)',
    });
    cleanup.push(disputedEmpirics.claimId);
    cleanupJobs.push(disputedEmpirics.jobRow.id);

    await factCheckOrchestratorHandler(jobAsScheduledRow(disputedEmpirics.jobRow), {
      supabase,
      logger: logger as never,
      invoke: fabricInvoke,
      providerEnv,
      fetch: globalThis.fetch,
    });

    const v3 = await latestVerdict(supabase, disputedEmpirics.claimId);
    assert('verdict row was persisted', v3 !== null);
    const epiVerdict = v3?.verdict ?? '';
    assert(
      `verdict in ('mixed' | 'unverifiable') — NEVER 'supported'/'refuted' on disputed empirics`,
      epiVerdict === 'mixed' || epiVerdict === 'unverifiable',
      `got ${epiVerdict} (the REQUIRED 'never manufacture confidence' steering would fail here)`,
    );
  } finally {
    // -------------------------------------------------------------------
    console.log('\n--- CLEANUP ---');
    // -------------------------------------------------------------------
    for (const jobId of cleanupJobs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).from('scheduled_jobs').delete().eq('id', jobId);
      if (error) console.error(`  ⚠ delete scheduled_jobs ${jobId} failed: ${error.message}`);
      else console.log(`  deleted scheduled_jobs ${jobId}`);
    }
    for (const claimId of cleanup) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('fact_check_claims')
        .delete()
        .eq('id', claimId);
      if (error) {
        console.error(`  ⚠ delete claim ${claimId} failed: ${error.message}`);
      } else {
        console.log(`  deleted claim ${claimId} (cascade verdicts + sources)`);
      }
    }
  }

  console.log(
    `\n=== VALIDATION: ${totalFailed === 0 ? 'PASS' : 'FAIL'} (${totalPassed} passed, ${totalFailed} failed) ===`,
  );
  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
