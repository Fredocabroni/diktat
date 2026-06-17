// drop_publish handler — promotes one candidate to today's Drop.
//
// Triggered by the existing drop_due_check pg_cron (PR #25) at 20:00–
// 23:59 ET. The first 20:00 ET tick of the day fires; later ticks no-op
// via the partial-unique idempotency index on (job_type, idempotency_key).
//
// Pipeline order:
//   1. Fetch active candidates (selected_at NULL, rejected_reason NULL,
//      dedup_cluster_id NOT NULL, rank_score NOT NULL), ordered by
//      rank_score desc.
//   2. Compute the blocked-cluster set: every dedup_cluster_id stamped
//      on a news_topics row where is_drop=true AND drop_at >= now - 2d.
//      Same cluster cannot be the Drop today or for the next 2 days.
//      "No score-dominance override" per the founder call.
//   3. Walk the ranked list and pick the first candidate whose cluster
//      is NOT in the blocked set. This is the chosen candidate.
//   4. Find the runner-up = top candidate in a DIFFERENT, also-unblocked,
//      cluster. (Within-cluster ranks don't compare — they're the same
//      story.)
//   5. Apply the confidence threshold:
//        chosen.score > 2 × runnerUp.score → curation_mode='auto_dominant'
//        else (tight spread)               → 'auto_fallback_no_channel'
//      V1 ships only these two paths; curator-channel paths are pre-
//      declared in the curation_mode enum but unused until the curator
//      notification PR lands.
//   6. Edge case: every active candidate is in a blocked cluster (slow
//      news week + cluster has rolled for 3 days). The §5 ADDICTION
//      contract is "never skip a day" — we still publish the top
//      candidate, stamp curation_mode='auto_fallback_no_channel', and
//      flag block_exhausted=true in the row's telemetry payload so ops
//      sees the exception.
//   7. LLM rewrite of the source title via the ai-fabric
//      drop_headline_rewrite task, using DROP_HEADLINE_REWRITE_SYSTEM_
//      PROMPT from packages/ai-fabric/src/prompts/drop-headline.ts as
//      the integrity contract. Structured output yields a Diktat-voice
//      headline + 1-sentence summary + a single fact-checkable claim.
//      Failure modes degrade gracefully: missing deps.invoke, model
//      error, or empty model output all fall back to source_title
//      verbatim (the §5 "never skip a day" contract trumps voice
//      polish).
//   8. Insert the chosen candidate as a news_topics row (is_drop=true,
//      drop_at=today 20:00 ET, dedup_cluster_id stamped forward for
//      the 3-day repeat-block scan). source_title preserved verbatim
//      regardless of rewrite outcome.
//   9. If the rewrite produced a non-empty claim, enqueue an auto-
//      fact-check by upserting fact_check_claims and inserting a
//      scheduled_jobs row of job_type='fact_check'. Mirrors the
//      trpc.factCheck.enqueue path (PR 4.7 contract) — same dedup
//      hash, same idempotency key shape.
//   10. Mark every candidate in the chosen cluster as selected_at=now()
//       so subsequent ingest ticks don't re-promote them.

import { createHash } from 'crypto';

import {
  DROP_HEADLINE_REWRITE_SYSTEM_PROMPT,
  buildDropHeadlineUserPrompt,
} from '@diktat/ai-fabric';
import { z } from 'zod';

import type { JobHandler } from './scheduler.js';

interface ActiveCandidate {
  id: string;
  source_provider: string;
  source_category: string;
  source_title: string;
  source_url: string;
  source_host: string;
  source_published_at: string | null;
  summary: string | null;
  dedup_cluster_id: string;
  rank_score: number;
}

interface DropOutcome {
  readonly chosen_candidate_id: string;
  readonly chosen_cluster_id: string;
  readonly chosen_score: number;
  readonly runner_up_cluster_id: string | null;
  readonly runner_up_score: number | null;
  readonly score_ratio: number | null;
  readonly curation_mode: 'auto_dominant' | 'auto_fallback_no_channel';
  readonly block_exhausted: boolean;
  readonly news_topic_id: string;
  readonly headline_rewritten: boolean;
  readonly fact_check_enqueued: boolean;
}

/** Structured-output contract for the LLM rewrite. Empty strings are
 *  ALLOWED per the drop-headline.ts prompt — "empty output preferred
 *  to a slanted rewrite." The handler falls back to source_title
 *  verbatim when headline is empty.
 *
 *  Headline + summary regex bars angle brackets and embedded URLs at
 *  the schema layer (defense in depth against a hostile feed prompt-
 *  injecting URL-shaped content into the Drop headline; security-
 *  reviewer ask, 2026-06-16). */
const SAFE_TEXT_RE = /^[^<>]*$/;
const DropHeadlineRewriteSchema = z.object({
  headline: z
    .string()
    .max(100, 'Headline exceeds 100-char cap.')
    .regex(SAFE_TEXT_RE, 'Headline may not contain angle brackets.')
    .refine((s) => !/https?:\/\//i.test(s), {
      message: 'Headline may not embed a URL.',
    }),
  summary: z
    .string()
    .max(400, 'Summary exceeds 400 chars.')
    .regex(SAFE_TEXT_RE, 'Summary may not contain angle brackets.'),
  claim: z.string().max(500, 'Claim exceeds 500 chars.'),
});
type DropHeadlineRewriteOutput = z.infer<typeof DropHeadlineRewriteSchema>;

/** Projected USD cost for one drop_headline_rewrite call. Sonnet 4.6
 *  pricing × short input + short output ≈ $0.002. The cost ledger
 *  asserts under this projection before invoking; failures stamp the
 *  real spend per the ai-fabric contract. */
const REWRITE_PROJECTED_USD = 0.005;

/** How far back the cluster-block lookup reaches. 2 days back + today
 *  = the 3-consecutive-day window from the founder spec ("today + next 2
 *  days excluded"). */
const CLUSTER_BLOCK_DAYS = 2;

/** Confidence threshold for auto_dominant: chosen.score must exceed
 *  this multiple of the runner-up's score. */
const DOMINANCE_RATIO = 2.0;

// ---------------------------------------------------------------------------
// Pure selection logic — exposed for testing.
// ---------------------------------------------------------------------------

/**
 * Pick the chosen candidate + runner-up from a ranked candidate pool,
 * honoring the cluster-block set. Returns null if the pool is empty.
 *
 * blockExhausted=true when every candidate is in a blocked cluster
 * (the §5 "never skip a day" path); the chosen candidate is then the
 * absolute top.
 */
export function selectDropFromPool(opts: {
  candidates: ReadonlyArray<ActiveCandidate>;
  blockedClusters: ReadonlySet<string>;
}): {
  chosen: ActiveCandidate;
  runnerUp: ActiveCandidate | null;
  blockExhausted: boolean;
} | null {
  if (opts.candidates.length === 0) return null;
  // Pre-sort by rank_score desc (defensive — caller should already
  // pass them ordered, but we don't trust caller ordering).
  const ranked = [...opts.candidates].sort((a, b) => b.rank_score - a.rank_score);

  // Walk for the first unblocked candidate.
  let chosen: ActiveCandidate | undefined;
  for (const c of ranked) {
    if (!opts.blockedClusters.has(c.dedup_cluster_id)) {
      chosen = c;
      break;
    }
  }
  let blockExhausted = false;
  if (!chosen) {
    // Every candidate is blocked. §5 contract: never skip a day. Pick
    // the absolute top (even though blocked) and stamp the
    // block_exhausted telemetry.
    chosen = ranked[0]!;
    blockExhausted = true;
  }

  // Runner-up = top candidate in a DIFFERENT cluster. Same cluster =
  // same story = invalid runner-up. Cluster-block does NOT apply to
  // the runner-up: it's a comparison signal, not a publishing
  // candidate, and we want the comparison to reflect the actual
  // strength of the chosen candidate against the next-strongest story
  // in the pool.
  const runnerUp = ranked.find((c) => c.dedup_cluster_id !== chosen!.dedup_cluster_id) ?? null;

  return { chosen, runnerUp, blockExhausted };
}

/**
 * Apply the confidence threshold to decide curation_mode.
 * - chosen.score > DOMINANCE_RATIO × runnerUp.score → 'auto_dominant'
 * - else → 'auto_fallback_no_channel' (V1: no curator channel)
 * If there's no runner-up (single-cluster pool), treat as dominant.
 */
export function decideCurationMode(opts: {
  chosenScore: number;
  runnerUpScore: number | null;
}): 'auto_dominant' | 'auto_fallback_no_channel' {
  if (opts.runnerUpScore === null || opts.runnerUpScore === 0) return 'auto_dominant';
  return opts.chosenScore > DOMINANCE_RATIO * opts.runnerUpScore
    ? 'auto_dominant'
    : 'auto_fallback_no_channel';
}

/** Today's 20:00 ET as ISO timestamp. ET local-time is the source-of-
 *  truth anchor (ADDICTION §5: "Never move The Drop time"). */
export function todayDropAtEt(now: Date): string {
  // Compute the local-ET date components for `now`.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  // 8 PM ET = 20:00. Build an ISO string in ET wall-clock, then convert
  // through the same offset logic Node uses for tz.
  const isoLocalEt = `${get('year')}-${get('month')}-${get('day')}T20:00:00`;
  // Use the tz-aware roundtrip: parse as if it's in ET. Date.UTC + tz
  // offset for that specific ET datetime. The cleanest way without a
  // dep: pass through an intermediate Date in UTC and let Intl handle
  // the offset.
  const etOffsetMs = etOffsetMsAt(isoLocalEt);
  const utcMs = Date.parse(`${isoLocalEt}Z`) - etOffsetMs;
  return new Date(utcMs).toISOString();
}

/** Return the offset (in ms) from UTC for America/New_York at the given
 *  ET wall-clock timestamp. DST-correct via Intl. */
function etOffsetMsAt(etWallClockIso: string): number {
  // Parse the ET wall-clock as if it were UTC, then ask Intl what the
  // ET-local representation of that UTC instant is. The difference is
  // the offset.
  const utcAsIfEt = new Date(`${etWallClockIso}Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(utcAsIfEt);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const reflected = Date.parse(
    `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`,
  );
  return reflected - utcAsIfEt.getTime();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const dropPublishHandler: JobHandler = async (row, deps) => {
  const now = new Date();

  // (1) Active candidates with a cluster + rank score, ranked.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: candData, error: candErr } = (await (deps.supabase as any)
    .from('news_topics_candidates')
    .select(
      'id, source_provider, source_category, source_title, source_url, source_host, source_published_at, summary, dedup_cluster_id, rank_score',
    )
    .is('selected_at', null)
    .is('rejected_reason', null)
    .not('dedup_cluster_id', 'is', null)
    .not('rank_score', 'is', null)
    .order('rank_score', { ascending: false })) as {
    data: ActiveCandidate[] | null;
    error: { message: string } | null;
  };
  if (candErr) throw new Error(`drop_publish: fetch candidates: ${candErr.message}`);
  const candidates = candData ?? [];
  if (candidates.length === 0) {
    await stampPayload(deps, row.id, { ...row.payload, no_candidates: true });
    deps.logger.warn({ event: 'drop_publish.no_candidates', jobId: row.id });
    return;
  }

  // (2) Blocked clusters from the last 3 days of Drops.
  const blockCutoff = new Date(now.getTime() - CLUSTER_BLOCK_DAYS * 86_400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: blockedData, error: blockedErr } = (await (deps.supabase as any)
    .from('news_topics')
    .select('dedup_cluster_id')
    .eq('is_drop', true)
    .gte('drop_at', blockCutoff)
    .not('dedup_cluster_id', 'is', null)) as {
    data: { dedup_cluster_id: string }[] | null;
    error: { message: string } | null;
  };
  if (blockedErr) throw new Error(`drop_publish: fetch blocked clusters: ${blockedErr.message}`);
  const blockedClusters = new Set((blockedData ?? []).map((r) => r.dedup_cluster_id));

  // (3-6) Select.
  const sel = selectDropFromPool({ candidates, blockedClusters });
  if (!sel) {
    // Unreachable given the empty-pool check above, but defensive.
    await stampPayload(deps, row.id, { ...row.payload, no_candidates: true });
    return;
  }
  const curationMode = decideCurationMode({
    chosenScore: sel.chosen.rank_score,
    runnerUpScore: sel.runnerUp ? sel.runnerUp.rank_score : null,
  });

  // (7) LLM rewrite — Diktat voice + claim extraction for fact-check.
  //     Falls back to source_title verbatim on any failure mode (no
  //     invoke configured, model error, empty model output). §5
  //     "never skip a day" trumps voice polish.
  const rewrite = await rewriteHeadlineSafely(deps, sel.chosen);

  // (8) Promote to news_topics. source_title preserved verbatim
  //     regardless of rewrite outcome.
  const dropAt = todayDropAtEt(now);
  const slug = await generateSlug(deps, sel.chosen, now);
  const finalHeadline = rewrite.headline.length > 0 ? rewrite.headline : sel.chosen.source_title;
  const finalSummary = rewrite.summary.length > 0 ? rewrite.summary : sel.chosen.summary;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: topicData, error: topicErr } = (await (deps.supabase as any)
    .from('news_topics')
    .insert({
      slug,
      headline: finalHeadline,
      source_title: sel.chosen.source_title,
      summary: finalSummary,
      primary_source_url: sel.chosen.source_url,
      category: sel.chosen.source_category,
      published_at: sel.chosen.source_published_at,
      drop_at: dropAt,
      is_drop: true,
      dedup_cluster_id: sel.chosen.dedup_cluster_id,
      curation_mode: curationMode,
      additional_sources: [],
    })
    .select('id')
    .single()) as { data: { id: string } | null; error: { message: string } | null };
  if (topicErr || !topicData) {
    throw new Error(`drop_publish: insert news_topics: ${topicErr?.message ?? 'no row'}`);
  }

  // (9) Auto-fact-check enqueue. Only when the rewrite produced a
  //     non-empty claim — empty means "no fact-checkable proposition"
  //     per drop-headline.ts rule 10. Mirrors trpc.factCheck.enqueue
  //     (PR 4.7 contract): upsert claim by dedup_hash + enqueue job.
  let factCheckEnqueued = false;
  if (rewrite.claim.length > 0) {
    factCheckEnqueued = await enqueueDropFactCheck(deps, {
      claimText: rewrite.claim,
      claimContext: `${sel.chosen.source_title}\n${sel.chosen.source_url}`,
      refId: topicData.id,
      now,
    });
  }

  // (10) Mark every candidate in the chosen cluster as selected_at=now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: markErr } = (await (deps.supabase as any)
    .from('news_topics_candidates')
    .update({ selected_at: now.toISOString() })
    .eq('dedup_cluster_id', sel.chosen.dedup_cluster_id)
    .is('selected_at', null)) as { error: { message: string } | null };
  if (markErr) {
    deps.logger.warn({
      event: 'drop_publish.mark_selected_failed',
      message: markErr.message,
    });
    // Non-fatal: the news_topics row was inserted; candidates table
    // staleness self-heals on the next retention sweep.
  }

  // Telemetry — stamp outcome into the row's payload.
  const outcome: DropOutcome = {
    chosen_candidate_id: sel.chosen.id,
    chosen_cluster_id: sel.chosen.dedup_cluster_id,
    chosen_score: sel.chosen.rank_score,
    runner_up_cluster_id: sel.runnerUp?.dedup_cluster_id ?? null,
    runner_up_score: sel.runnerUp?.rank_score ?? null,
    score_ratio:
      sel.runnerUp && sel.runnerUp.rank_score > 0
        ? sel.chosen.rank_score / sel.runnerUp.rank_score
        : null,
    curation_mode: curationMode,
    block_exhausted: sel.blockExhausted,
    news_topic_id: topicData.id,
    headline_rewritten: rewrite.headline.length > 0,
    fact_check_enqueued: factCheckEnqueued,
  };
  await stampPayload(deps, row.id, { ...row.payload, outcome });

  deps.logger.info({
    event: 'drop_publish.complete',
    jobId: row.id,
    ...outcome,
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a slug from the source title + ET date. Citext-unique on
 *  news_topics.slug; collisions retry once with a -2, -3 suffix
 *  before giving up. */
async function generateSlug(
  deps: Parameters<JobHandler>[1],
  candidate: ActiveCandidate,
  now: Date,
): Promise<string> {
  const datePart = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const base = candidate.source_title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const fallback = `drop-${datePart}-${candidate.id.slice(0, 8)}`;
  const slug = base.length > 0 ? `${datePart}-${base}` : fallback;

  // Check if the slug already exists; if so, append a numeric suffix.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = (await (deps.supabase as any)
    .from('news_topics')
    .select('slug')
    .eq('slug', slug)
    .maybeSingle()) as { data: { slug: string } | null; error: unknown };
  if (!data) return slug;
  for (let i = 2; i < 10; i += 1) {
    const trySlug = `${slug}-${i}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = (await (deps.supabase as any)
      .from('news_topics')
      .select('slug')
      .eq('slug', trySlug)
      .maybeSingle()) as { data: { slug: string } | null };
    if (!existing) return trySlug;
  }
  // Last-resort uniqueness — full uuid suffix.
  return `${slug}-${candidate.id.slice(0, 8)}`;
}

async function stampPayload(
  deps: Parameters<JobHandler>[1],
  rowId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = (await (deps.supabase as any)
    .from('scheduled_jobs')
    .update({ payload })
    .eq('id', rowId)) as { error: { message: string } | null };
  if (error) {
    throw new Error(`drop_publish: stamp payload: ${error.message}`);
  }
}

/** Call the ai-fabric drop_headline_rewrite task. Returns empty strings
 *  on any failure (missing invoke, model error, empty model output).
 *  The handler treats empty headline as "fall back to source_title
 *  verbatim" — §5 "never skip a day" trumps voice polish. */
async function rewriteHeadlineSafely(
  deps: Parameters<JobHandler>[1],
  candidate: ActiveCandidate,
): Promise<DropHeadlineRewriteOutput> {
  const empty: DropHeadlineRewriteOutput = { headline: '', summary: '', claim: '' };
  if (!deps.invoke) {
    deps.logger.warn({
      event: 'drop_publish.rewrite_skipped',
      reason: 'no_invoke',
      candidateId: candidate.id,
    });
    return empty;
  }
  try {
    const result = await deps.invoke({
      task: 'drop_headline_rewrite',
      system: DROP_HEADLINE_REWRITE_SYSTEM_PROMPT,
      user: buildDropHeadlineUserPrompt({
        sourceTitle: candidate.source_title,
        sourceUrl: candidate.source_url,
        sourceHost: candidate.source_host,
        sourceCategory: candidate.source_category,
        sourceSummary: candidate.summary,
      }),
      schema: DropHeadlineRewriteSchema,
      env: deps.providerEnv ?? { xaiAvailable: false, perplexityAvailable: false },
      projectedUsd: REWRITE_PROJECTED_USD,
      maxTokens: 512,
    });
    return result.output as DropHeadlineRewriteOutput;
  } catch (err) {
    deps.logger.warn({
      event: 'drop_publish.rewrite_failed',
      candidateId: candidate.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

/** Upsert the claim into fact_check_claims and enqueue a fact_check
 *  scheduled_jobs row. Mirrors the trpc.factCheck.enqueue path (PR
 *  4.7 contract) — same sha256(claim_text + '\n---\n' + claim_context)
 *  dedup hash, same {claim_id}:{UTC_day} idempotency_key shape.
 *  Returns true if a new fact_check job row landed; false on any
 *  silent failure (23505 same-day dup is acceptable). Failures are
 *  logged but never throw — auto-fact-check is best-effort, the Drop
 *  publishes regardless. */
async function enqueueDropFactCheck(
  deps: Parameters<JobHandler>[1],
  opts: { claimText: string; claimContext: string; refId: string; now: Date },
): Promise<boolean> {
  const dedupHash = createHash('sha256')
    .update(`${opts.claimText}\n---\n${opts.claimContext}`)
    .digest('hex');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upsertErr } = (await (deps.supabase as any).from('fact_check_claims').upsert(
    {
      claim_text: opts.claimText,
      claim_context: opts.claimContext,
      dedup_hash: dedupHash,
      ref_type: 'news_topic',
      ref_id: opts.refId,
    },
    { onConflict: 'dedup_hash', ignoreDuplicates: true },
  )) as { error: { message: string } | null };
  if (upsertErr) {
    deps.logger.warn({
      event: 'drop_publish.fact_check_upsert_failed',
      message: upsertErr.message,
    });
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimRow, error: selectErr } = (await (deps.supabase as any)
    .from('fact_check_claims')
    .select('id')
    .eq('dedup_hash', dedupHash)
    .maybeSingle()) as { data: { id: string } | null; error: { message: string } | null };
  if (selectErr || !claimRow) {
    deps.logger.warn({
      event: 'drop_publish.fact_check_select_failed',
      message: selectErr?.message ?? 'no row',
    });
    return false;
  }

  const utcDay = opts.now.toISOString().slice(0, 10);
  const idempotencyKey = `${claimRow.id}:${utcDay}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: jobErr } = (await (deps.supabase as any).from('scheduled_jobs').insert({
    job_type: 'fact_check',
    idempotency_key: idempotencyKey,
    payload: {
      claim_id: claimRow.id,
      enqueued_at: opts.now.toISOString(),
      enqueued_by: 'drop_publish',
    },
  })) as { error: { code?: string; message: string } | null };
  if (jobErr) {
    // 23505 = unique violation on (job_type, idempotency_key) — a same-
    // UTC-day re-enqueue is acceptable (orchestrator cache-hits anyway).
    if (jobErr.code === '23505') return false;
    deps.logger.warn({ event: 'drop_publish.fact_check_enqueue_failed', message: jobErr.message });
    return false;
  }
  return true;
}

export const __testing = {
  selectDropFromPool,
  decideCurationMode,
  todayDropAtEt,
  CLUSTER_BLOCK_DAYS,
  DOMINANCE_RATIO,
};
