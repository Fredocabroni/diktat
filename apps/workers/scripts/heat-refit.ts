// pnpm --filter=@diktat/workers heat:refit
//
// Offline tool. Reads the last 30 reviewed drop_shadow_log rows
// (operator picks + explicit skips) and prints:
//   - agreement stats (how often heat #1 == operator pick, pick's
//     rank distribution, skip-day heat ceiling);
//   - a proposed one-step z-score nudge to DEFAULT_HEAT_WEIGHTS.
//
// NEVER writes weights. The operator reads the printed report and
// applies the proposed values by editing apps/workers/src/jobs/
// heat/weights.ts by hand. This keeps the version-controlled
// weights file the single source of truth and prevents a stray
// cron / CI run from silently retuning the heat composer.
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set. The
// loadEnv() factory asserts them; a missing var crashes the script
// before any DB access.
//
// Exit: 0 on success (including "no rows" — the report is still
// printed). Non-zero only on a DB error.

import { loadEnv } from '../src/env.js';
import {
  computeAgreementStats,
  formatReport,
  proposeWeights,
  type ReviewedShadowRow,
} from '../src/jobs/heat/refit.js';
import { DEFAULT_HEAT_WEIGHTS } from '../src/jobs/heat/weights.js';
import { buildServiceClient } from '../src/supabase.js';

const WINDOW_NIGHTS = 30;

async function main(): Promise<void> {
  const env = loadEnv();
  const client = buildServiceClient(env);

  const { data, error } = await client
    .from('drop_shadow_log')
    .select('drop_date, operator_pick_candidate_id, operator_picked_at, shadow_top_5')
    .not('operator_picked_at', 'is', null)
    .order('drop_date', { ascending: false })
    .limit(WINDOW_NIGHTS);

  if (error) {
     
    console.error(`heat:refit — failed to load drop_shadow_log: ${error.message}`);
    process.exit(1);
  }

  const rows = (data ?? []) as unknown as ReadonlyArray<ReviewedShadowRow>;
  const stats = computeAgreementStats(rows);
  const proposed = proposeWeights(rows, DEFAULT_HEAT_WEIGHTS);

  const windowLabel =
    rows.length === 0
      ? 'last 30 reviewed nights (none found yet)'
      : `last ${rows.length} reviewed nights (newest ${rows[0]!.drop_date}, oldest ${rows[rows.length - 1]!.drop_date})`;

  // eslint-disable-next-line no-console
  console.log(formatReport(stats, proposed, windowLabel));
}

main().catch((err: unknown) => {
   
  console.error(
    `heat:refit — unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
