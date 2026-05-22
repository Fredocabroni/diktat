// Manual one-shot seed script for the initial 200 verified trivia
// questions. Run after PR #16 merges, before PR #18 (battle flow):
//
//   pnpm --filter=@diktat/workers seed:trivia
//
// The script wires the Upstash REST cost sink so its spend lands in
// the shared daily ledger — if running concurrently with a workers
// process, both share the $3/day trivia_gen cap. If the cap is hit
// mid-run the next batch fails fast with BudgetExceededError; rerun
// the next UTC day to top up the missing categories.
//
// Idempotency note: each invocation writes fresh rows. The trivia
// pipeline does not dedupe by prompt-hash today (a soft duplicate
// won't break the schema's uniqueness — there is none — but the
// generated drafts are random, so collisions are unlikely). If you
// re-run after a partial failure, expect overlap in unaffected
// categories. Future cleanup migration can dedupe by (category,
// prompt) when needed.

import {
  buildUpstashCostSink,
  hydrateLedgerFromSink,
  invoke,
  setCostSink,
  type ProviderEnv,
} from '@diktat/ai-fabric';

import { loadEnv } from '../src/env.js';
import { runTriviaGen } from '../src/jobs/trivia-gen.js';
import { buildLogger } from '../src/logger.js';
import { buildRedis } from '../src/redis.js';
import { buildServiceClient } from '../src/supabase.js';

interface CategoryPlan {
  readonly category: string;
  readonly count: number;
  readonly difficultyBand: readonly [number, number];
}

// Aligned with MASTER_PLAN.md §8 primary sources.
const CATEGORIES: readonly CategoryPlan[] = [
  { category: 'congress_bills', count: 20, difficultyBand: [1, 7] },
  { category: 'fed_data', count: 20, difficultyBand: [2, 7] },
  { category: 'scotus', count: 20, difficultyBand: [3, 8] },
  { category: 'elections', count: 20, difficultyBand: [1, 6] },
  { category: 'fbi_crimestats', count: 20, difficultyBand: [2, 7] },
  { category: 'cdc_data', count: 20, difficultyBand: [2, 7] },
  { category: 'sec_filings', count: 20, difficultyBand: [3, 8] },
  { category: 'dol_jobs', count: 20, difficultyBand: [2, 7] },
  { category: 'treasury', count: 20, difficultyBand: [3, 8] },
  { category: 'defense_budget', count: 20, difficultyBand: [3, 8] },
];

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = buildLogger(env);
  const supabase = buildServiceClient(env);

  // Wire the cross-process cost ledger so this run respects (and
  // contributes to) the shared $3/day trivia_gen cap.
  const redis = buildRedis(env);
  setCostSink(buildUpstashCostSink(redis));
  await hydrateLedgerFromSink();

  // Provider env: only Anthropic + OpenAI + Google are configured by
  // default. xAI / Perplexity stubs throw; routing already filters
  // them out when the flags are false.
  const providerEnv: ProviderEnv = {
    xaiAvailable: Boolean(process.env.XAI_API_KEY),
    perplexityAvailable: Boolean(process.env.PERPLEXITY_API_KEY),
  };

  let totals = { generated: 0, verified: 0, rejected: 0, failed: 0 };

  // Skip categories that already have enough verified rows. Re-running the
  // seed after partial completion (network failure, ctrl-c) shouldn't re-spend
  // on categories that are already done.
  const SKIP_THRESHOLD = 15;

  for (const plan of CATEGORIES) {
    const existing = await supabase
      .from('trivia_questions')
      .select('id', { count: 'exact', head: true })
      .eq('category', plan.category)
      .eq('verified', true);
    const verifiedCount = existing.count ?? 0;
    if (verifiedCount >= SKIP_THRESHOLD) {
      logger.info({
        event: 'seed-trivia.batch.skip',
        category: plan.category,
        verifiedCount,
        threshold: SKIP_THRESHOLD,
      });
      continue;
    }

    logger.info({
      event: 'seed-trivia.batch.start',
      category: plan.category,
      count: plan.count,
      existingVerified: verifiedCount,
    });

    const result = await runTriviaGen(plan, {
      invoke,
      supabase,
      logger,
      providerEnv,
    });

    totals = {
      generated: totals.generated + result.generated,
      verified: totals.verified + result.verified,
      rejected: totals.rejected + result.rejected,
      failed: totals.failed + result.failed,
    };

    logger.info({
      event: 'seed-trivia.batch.done',
      category: plan.category,
      ...result,
    });
  }

  logger.info({ event: 'seed-trivia.totals', ...totals });

  if (totals.verified === 0) {
    process.exit(1);
  }
}

void main().catch((err) => {
   
  console.error('seed-trivia: fatal:', err);
  process.exit(1);
});
