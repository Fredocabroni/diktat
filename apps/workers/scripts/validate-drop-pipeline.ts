// Integration validation for the Drop news-sourcing pipeline. Exercises
// dedup + rank + publish + cluster-block end-to-end against the dev DB.
// Does NOT call the live LLM (no rewrite, no fact-check enqueue) — the
// unit suite covers those paths; this script proves the DB-layer
// contract works on a real Postgres + the migration's CHECK constraints
// behave as designed.
//
// Run:
//   (set -a; . /Users/tyrionlannister/diktat/.env.local; set +a; \
//      pnpm --filter=@diktat/workers exec tsx scripts/validate-drop-pipeline.ts)
//
// Hard guard: aborts unless SUPABASE_URL targets the dev project ref.
//
// What it does:
//   1. Seeds 4 candidate rows: 3 in cluster 'STORY-X' (Senate-passes-
//      HR-1234 paraphrases from congress + bls + sec_edgar) and 1
//      isolated candidate from a different topic (cdc flu data).
//   2. Runs news_dedup_rank → asserts 2 distinct clusters, 3 candidates
//      share one cluster id, rank scores stamped (density 3 > density 1).
//   3. Runs drop_publish → asserts a news_topics row was created with
//      is_drop=true, source_title verbatim, dedup_cluster_id stamped.
//   4. Asserts every candidate in the chosen cluster has selected_at set.
//   5. Re-runs drop_publish with a fresh candidate batch including the
//      same cluster — asserts the 3-day cluster block kicks in and the
//      different-cluster candidate becomes the Drop.
//   6. Cleanup: delete the synthetic news_topics + candidates rows.
//
// What it does NOT do (out of scope):
//   - Live LLM rewrite (no deps.invoke wired in the script).
//   - Live RSS fetch (no news_ingest run — candidates are seeded
//     directly into the table).
//   - GDELT integration (not in V1).

import { buildNewsIngestHandler, type CandidateInput } from '../src/jobs/news-ingest.js';
import { newsDedupRankHandler } from '../src/jobs/news-dedup-rank.js';
import { dropPublishHandler } from '../src/jobs/drop-publish.js';
import type { ScheduledJobRow } from '../src/jobs/scheduler.js';
import { buildLogger } from '../src/logger.js';
import { loadEnv } from '../src/env.js';
import { buildServiceClient, type ServiceClient } from '../src/supabase.js';
import { randomUUID } from 'crypto';

const DEV_PROJECT_REF = 'immzaaysjlftyijwdsrm';

const DEDUP_RANK_JOB_ID = randomUUID();
const DROP_PUBLISH_JOB_ID = randomUUID();

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = (c: ServiceClient) => c as any;

interface CandidateRowSnap {
  id: string;
  source_provider: string;
  source_title: string;
  source_url: string;
  source_host: string;
  source_category: string;
  source_published_at: string | null;
  summary: string | null;
  dedup_url_canon: string;
  dedup_cluster_id: string | null;
  rank_score: number | null;
  selected_at: string | null;
  rejected_reason: string | null;
}

interface NewsTopicSnap {
  id: string;
  slug: string;
  headline: string;
  source_title: string | null;
  dedup_cluster_id: string | null;
  is_drop: boolean;
  drop_at: string | null;
  curation_mode: string | null;
}

const PROVIDER_TAG = 'validate-drop';

async function seedCandidate(supabase: ServiceClient, c: CandidateInput): Promise<string> {
  const { data, error } = await sb(supabase)
    .from('news_topics_candidates')
    .insert({
      source_provider: c.source_provider,
      source_category: c.source_category,
      source_title: c.source_title,
      source_url: c.source_url,
      source_host: c.source_host,
      source_published_at: c.source_published_at,
      summary: c.summary,
      dedup_url_canon: c.dedup_url_canon,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seedCandidate: ${error?.message ?? 'no row'}`);
  return (data as { id: string }).id;
}

async function fetchCandidate(supabase: ServiceClient, id: string): Promise<CandidateRowSnap> {
  const { data, error } = await sb(supabase)
    .from('news_topics_candidates')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`fetchCandidate: ${error?.message}`);
  return data as CandidateRowSnap;
}

function dropPublishRow(): ScheduledJobRow {
  return {
    id: DROP_PUBLISH_JOB_ID,
    job_type: 'drop_publish',
    idempotency_key: `validate-${Date.now()}`,
    target_user_id: null,
    payload: {},
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'validate-script',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function dedupRankRow(): ScheduledJobRow {
  return { ...dropPublishRow(), id: DEDUP_RANK_JOB_ID, job_type: 'news_dedup_rank' };
}

async function ensureSchedulerJob(
  supabase: ServiceClient,
  id: string,
  job_type: string,
): Promise<void> {
  // The handlers stamp telemetry into scheduled_jobs.payload, so a real
  // row must exist for that UPDATE to land.
  const ts = new Date().toISOString();
  await sb(supabase).from('scheduled_jobs').upsert(
    {
      id,
      job_type,
      idempotency_key: id,
      payload: {},
      status: 'processing',
      attempts: 1,
      max_attempts: 5,
      available_at: ts,
      locked_at: ts,
      locked_by: 'validate-script',
    },
    { onConflict: 'id' },
  );
}

async function cleanup(
  supabase: ServiceClient,
  candIds: string[],
  topicIds: string[],
  schedulerIds: string[],
): Promise<void> {
  if (candIds.length > 0) {
    await sb(supabase).from('news_topics_candidates').delete().in('id', candIds);
  }
  if (topicIds.length > 0) {
    await sb(supabase).from('news_topics').delete().in('id', topicIds);
  }
  if (schedulerIds.length > 0) {
    await sb(supabase).from('scheduled_jobs').delete().in('id', schedulerIds);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL.includes(DEV_PROJECT_REF)) {
    console.error(`Refusing to run: SUPABASE_URL does not target ${DEV_PROJECT_REF}.`);
    process.exit(2);
  }
  const supabase = buildServiceClient(env);
  const logger = buildLogger(env);

  console.log('Drop pipeline validation against dev DB.\n');

  const ts = Date.now();
  const candIds: string[] = [];
  const topicIds: string[] = [];
  const schedulerIds: string[] = [];

  try {
    // -----------------------------------------------------------------
    // 1) Seed 4 candidates — 3 in cluster STORY-X, 1 isolated.
    // -----------------------------------------------------------------
    console.log('▶ Seed: 3-outlet same-story cluster + 1 isolated candidate');
    const congressId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-congress`,
      source_category: 'congress',
      source_title: `${ts} Senate passes HR-1234 52-48`,
      source_url: `https://www.congress.gov/bill/${ts}-hr1234`,
      source_host: 'congress.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://congress.gov/bill/${ts}-hr1234`,
    });
    const blsId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-bls`,
      source_category: 'bls_labor',
      source_title: `${ts} HR-1234 passes Senate 52-48 vote`,
      source_url: `https://www.bls.gov/labor/${ts}-hr1234`,
      source_host: 'bls.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://bls.gov/labor/${ts}-hr1234`,
    });
    const secId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-sec`,
      source_category: 'sec_filings',
      source_title: `${ts} Senate confirms HR-1234 52-48`,
      source_url: `https://www.sec.gov/filings/${ts}-hr1234`,
      source_host: 'sec.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://sec.gov/filings/${ts}-hr1234`,
    });
    const isolatedId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-cdc`,
      source_category: 'cdc_health',
      source_title: `${ts} CDC reports flu activity at year low`,
      source_url: `https://www.cdc.gov/flu/${ts}-update`,
      source_host: 'cdc.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://cdc.gov/flu/${ts}-update`,
    });
    candIds.push(congressId, blsId, secId, isolatedId);

    // -----------------------------------------------------------------
    // 2) Run dedup_rank — assert clustering + scoring.
    // -----------------------------------------------------------------
    console.log('\n▶ news_dedup_rank: cluster + score');
    await ensureSchedulerJob(supabase, DEDUP_RANK_JOB_ID, 'news_dedup_rank');
    schedulerIds.push(DEDUP_RANK_JOB_ID);
    await newsDedupRankHandler(dedupRankRow(), { supabase, logger });

    const congressAfter = await fetchCandidate(supabase, congressId);
    const blsAfter = await fetchCandidate(supabase, blsId);
    const secAfter = await fetchCandidate(supabase, secId);
    const isolatedAfter = await fetchCandidate(supabase, isolatedId);

    assert(
      'three same-story candidates share one cluster id',
      congressAfter.dedup_cluster_id !== null &&
        congressAfter.dedup_cluster_id === blsAfter.dedup_cluster_id &&
        congressAfter.dedup_cluster_id === secAfter.dedup_cluster_id,
      `got ${congressAfter.dedup_cluster_id} / ${blsAfter.dedup_cluster_id} / ${secAfter.dedup_cluster_id}`,
    );
    assert(
      'isolated candidate is in a DIFFERENT cluster',
      isolatedAfter.dedup_cluster_id !== null &&
        isolatedAfter.dedup_cluster_id !== congressAfter.dedup_cluster_id,
    );
    assert(
      'cluster-of-3 rank_score > cluster-of-1 rank_score (density signal)',
      congressAfter.rank_score !== null &&
        isolatedAfter.rank_score !== null &&
        congressAfter.rank_score > isolatedAfter.rank_score,
      `got ${congressAfter.rank_score} vs ${isolatedAfter.rank_score}`,
    );

    // -----------------------------------------------------------------
    // 3) Run drop_publish — assert a news_topics Drop is created.
    // -----------------------------------------------------------------
    console.log('\n▶ drop_publish: cluster-of-3 wins, news_topics row inserted');
    await ensureSchedulerJob(supabase, DROP_PUBLISH_JOB_ID, 'drop_publish');
    schedulerIds.push(DROP_PUBLISH_JOB_ID);
    await dropPublishHandler(dropPublishRow(), { supabase, logger });

    const { data: createdDrops } = await sb(supabase)
      .from('news_topics')
      .select('id, slug, headline, source_title, dedup_cluster_id, is_drop, drop_at, curation_mode')
      .eq('dedup_cluster_id', congressAfter.dedup_cluster_id)
      .eq('is_drop', true);
    const drop = (createdDrops as NewsTopicSnap[] | null)?.[0];
    if (drop) topicIds.push(drop.id);

    assert('news_topics row created with is_drop=true', drop !== undefined);
    // The drop_publish handler picks the candidate with the highest
    // per-row rank_score in the cluster — could be any of the three
    // co-clustered titles (they tie in density × recency × velocity;
    // ordering within the cluster is implementation-defined). Assert
    // headline === source_title (verbatim contract) without pinning
    // which specific candidate's title was picked.
    const clusterTitles = new Set([
      congressAfter.source_title,
      blsAfter.source_title,
      secAfter.source_title,
    ]);
    assert(
      'headline = verbatim source_title (no LLM in validation; rewrite path tested in unit suite)',
      drop?.headline === drop?.source_title && clusterTitles.has(drop?.headline ?? ''),
    );
    assert(
      'dedup_cluster_id stamped forward from candidate',
      drop?.dedup_cluster_id === congressAfter.dedup_cluster_id,
    );
    assert(
      'curation_mode is auto_dominant (density 3 > 2× density 1 = score ratio 3/1 = 3.0x)',
      drop?.curation_mode === 'auto_dominant',
      `got ${drop?.curation_mode}`,
    );

    // -----------------------------------------------------------------
    // 4) Cluster candidates marked selected.
    // -----------------------------------------------------------------
    console.log('\n▶ post-drop_publish: candidates in chosen cluster marked selected');
    const congressAfterPub = await fetchCandidate(supabase, congressId);
    const blsAfterPub = await fetchCandidate(supabase, blsId);
    const secAfterPub = await fetchCandidate(supabase, secId);
    const isolatedAfterPub = await fetchCandidate(supabase, isolatedId);
    assert(
      'all three chosen-cluster candidates have selected_at set',
      congressAfterPub.selected_at !== null &&
        blsAfterPub.selected_at !== null &&
        secAfterPub.selected_at !== null,
    );
    assert(
      'isolated candidate (different cluster) NOT marked selected',
      isolatedAfterPub.selected_at === null,
    );

    // -----------------------------------------------------------------
    // 5) Re-seed + re-run: 3-day cluster block must redirect to runner-up.
    // -----------------------------------------------------------------
    console.log('\n▶ 3-day cluster block: re-seed same cluster, runner-up wins');
    // Seed a fresh "Senate passes HR-1234" cluster + a different
    // unblocked story.
    const tsB = Date.now();
    const reseedSenateId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-congress-b`,
      source_category: 'congress',
      source_title: `${tsB} Senate passes HR-1234 52-48`,
      source_url: `https://www.congress.gov/bill/${tsB}-hr1234`,
      source_host: 'congress.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://congress.gov/bill/${tsB}-hr1234`,
    });
    const reseedSenateSecId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-sec-b`,
      source_category: 'sec_filings',
      source_title: `${tsB} HR-1234 passes Senate vote 52-48`,
      source_url: `https://www.sec.gov/filings/${tsB}-hr1234`,
      source_host: 'sec.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://sec.gov/filings/${tsB}-hr1234`,
    });
    const reseedCdcId = await seedCandidate(supabase, {
      source_provider: `${PROVIDER_TAG}-cdc-b`,
      source_category: 'cdc_health',
      source_title: `${tsB} CDC reports new vaccine guidance issued`,
      source_url: `https://www.cdc.gov/vax/${tsB}-update`,
      source_host: 'cdc.gov',
      source_published_at: new Date().toISOString(),
      summary: null,
      dedup_url_canon: `https://cdc.gov/vax/${tsB}-update`,
    });
    candIds.push(reseedSenateId, reseedSenateSecId, reseedCdcId);

    await newsDedupRankHandler(dedupRankRow(), { supabase, logger });

    // Critical: the just-published Drop's cluster id is now blocked for
    // the next 2 days. The new senate cluster (density 2) should be
    // assigned its OWN cluster id but will it get blocked?
    //
    // The clusterer is fresh-uuid-per-run, so the new "senate passes"
    // cluster gets a DIFFERENT uuid from the first one. The 3-day block
    // is keyed on the prior Drop's cluster id, not on headline content.
    //
    // Conclusion: this test validates the DB layer behavior. The
    // headline-based persistence-of-cluster-id-across-runs is a v2
    // enhancement (would require persistent cluster centroids or
    // headline-fingerprint indexing). Documented in the PR body.
    //
    // For V1 we instead test: if we manually inject a prior Drop with
    // the new cluster's id, the next drop_publish skips it.
    const senateB = await fetchCandidate(supabase, reseedSenateId);
    const newClusterId = senateB.dedup_cluster_id;
    if (newClusterId) {
      // Force the block by re-stamping the existing news_topics Drop
      // with the new cluster id (simulates "we already covered this
      // cluster"). Real prod gets here via consistent cluster ids that
      // the v2 persistent-clusterer would assign.
      await sb(supabase)
        .from('news_topics')
        .update({ dedup_cluster_id: newClusterId })
        .eq('id', drop!.id);

      await dropPublishHandler(dropPublishRow(), { supabase, logger });

      const { data: dropsB } = await sb(supabase)
        .from('news_topics')
        .select(
          'id, slug, headline, source_title, dedup_cluster_id, is_drop, drop_at, curation_mode',
        )
        .eq('is_drop', true)
        .gte('drop_at', new Date(Date.now() - 60_000).toISOString());
      const newDrops = (dropsB as NewsTopicSnap[] | null) ?? [];
      for (const d of newDrops)
        if (d.id !== drop?.id && !topicIds.includes(d.id)) topicIds.push(d.id);

      const cdcCand = await fetchCandidate(supabase, reseedCdcId);
      const senateBCand = await fetchCandidate(supabase, reseedSenateId);
      assert(
        'with senate cluster blocked, CDC-vaccine candidate (unblocked) becomes the Drop',
        cdcCand.selected_at !== null && senateBCand.selected_at === null,
        `cdc.selected_at=${cdcCand.selected_at}, senate.selected_at=${senateBCand.selected_at}`,
      );
    } else {
      console.log("  (skip block test — re-seed didn't produce a cluster id)");
    }
  } finally {
    await cleanup(supabase, candIds, topicIds, schedulerIds);
    console.log('\nCleanup complete.');
  }

  console.log(`\n${totalPassed} passed, ${totalFailed} failed.`);
  // Suppress unused-import warning for the ingest factory — kept here
  // as a forward-compat hook for a future "validate with live RSS"
  // mode toggled by an env flag.
  void buildNewsIngestHandler;
  process.exit(totalFailed === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('Validation script failed:', err);
  process.exit(2);
});
