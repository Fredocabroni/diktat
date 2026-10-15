// drop_publish handler — promotes one candidate to today's Drop.
//
// Triggered by the existing drop_due_check pg_cron (PR #25) at 20:00–
// 23:59 ET. The first 20:00 ET tick of the day fires; later ticks no-op
// via the partial-unique idempotency index on (job_type, idempotency_key).
//
// PR C changes (2026-10-14):
//   - Candidate list now sourced from the SECURITY DEFINER RPC
//     `pick_drop_eligible_candidates` (migration 20261019000000), which
//     enforces S3 outlet-balance in SQL: reputable-tier candidates only
//     pass when their GDELT cluster has >=2 distinct hosts from >=2
//     distinct outlet_groups AND >=1 news-type outlet AND the cluster
//     has not already been Drop-published.
//   - Reputable-tier candidates have their news-type article text
//     fetched via `fetchFirstReadable(pickTextSources(cluster.outlets,
//     best_news_url, best_news_host))`. The fetched URL becomes
//     `primary_source_url`; the fetched title + description feed the
//     headline rewrite and fact explainer. If no readable text is found
//     for a reputable candidate, the handler walks to the next eligible
//     candidate — "nothing readable = next eligible candidate".
//   - Commentary mentions can appear in a cluster's outlet set (they
//     count toward the 2-host / 2-group spread) but are NEVER the Drop
//     link — `pickTextSources` already drops commentary outlets.
//   - Primary / direct candidates publish unchanged (their source_url
//     IS the primary document; no cluster lookup, no fetch).
//   - After a reputable Drop lands, `stamp_cluster_drop_published` RPC
//     stamps the cluster so it cannot be Dropped again.
//
// Pipeline order (updated):
//   1. Fetch eligible candidates via pick_drop_eligible_candidates RPC.
//   2. Compute the blocked-cluster set: every dedup_cluster_id stamped
//      on a news_topics row where is_drop=true AND drop_at >= now - 2d.
//   3. Walk ranked candidates. For each unblocked candidate:
//        - primary/direct: use as-is → publish and done.
//        - reputable: load cluster outlets, pickTextSources,
//          fetchFirstReadable; if a news-type outlet yields readable
//          text, use it → publish and done. If no readable text,
//          continue to next candidate.
//   4. If no candidate yielded a publishable Drop AND some candidates
//      were blocked (block-exhaustion edge), make a second pass that
//      ignores the blocked set — the §5 "never skip a day" contract.
//   5. If both passes fail, stamp `no_candidates: true`.
//   6. LLM rewrite + fact explainer feed on the fetched text (reputable)
//      or candidate source_title (primary/direct).
//   7. Insert the chosen candidate as a news_topics row.
//   8. Enqueue auto-fact-check (gated by FACT_CHECK_ENABLED).
//   9. For reputable Drops: stamp the GDELT cluster via
//      stamp_cluster_drop_published RPC.
//   10. Mark every candidate in the chosen cluster as selected_at=now().

import { createHash } from 'crypto';

import { scrubMessage } from '@diktat/shared/alerts';

import {
  DROP_HEADLINE_REWRITE_SYSTEM_PROMPT,
  TOPIC_FACT_EXPLAINER_SYSTEM_PROMPT,
  buildDropHeadlineUserPrompt,
  buildTopicFactExplainerUserPrompt,
} from '@diktat/ai-fabric';
import { z } from 'zod';

import type { JobHandler } from './scheduler.js';
import {
  fetchFirstReadable,
  pickTextSources,
  type DropTextSource,
  type GdeltClusterOutletRow,
} from './drop-source-text-fetch.js';

type EvidenceTier = 'primary' | 'direct' | 'reputable';
type OutletType = 'news' | 'commentary' | null;

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
  // PR C — added so the handler can enforce S3 at Drop time.
  evidence_tier: EvidenceTier;
  outlet_type: OutletType;
  global_event_id: string | null;
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
  // PR C — new fields.
  readonly evidence_tier: EvidenceTier;
  readonly text_fetched: boolean;
  readonly fetched_host: string | null;
  readonly cluster_stamped: boolean;
}

/** Structured-output contract for the LLM rewrite. Empty strings are
 *  ALLOWED per the drop-headline.ts prompt — "empty output preferred
 *  to a slanted rewrite." The handler falls back to the fetched title
 *  (reputable) or source_title (primary/direct) verbatim when headline
 *  is empty.
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

/** Structured-output contract for the topic_fact_explainer task (A4).
 *  All four fields may be empty / null — "empty output preferred to a
 *  slanted explainer" per packages/ai-fabric/src/prompts/fact-explainer.ts
 *  rule 10. The handler persists null when the explainer isn't neutral-
 *  able, and the UI falls through to the raw primary_source_url link.
 *
 *  Posture steers UI copy:
 *    - 'contested'   → render both for_summary + against_summary
 *    - 'single_sided'→ render for_summary; against_summary must be empty
 *    - 'empirical'   → same as single_sided (false-balance guard) */
const FactExplainerPostureSchema = z.enum(['contested', 'single_sided', 'empirical']);
const FactExplainerSchema = z.object({
  for_summary: z.string().max(1000, 'for_summary exceeds 1000 chars.'),
  against_summary: z.string().max(1000, 'against_summary exceeds 1000 chars.'),
  // Scheme-constrained: empty OR https:// — never javascript:, data:, or
  // http: (security-reviewer PR #198 HIGH #2 — stored XSS vector when
  // DropCard renders this inside an anchor). The empty branch covers the
  // "could not neutralize" escape hatch.
  //
  // Also require a minimum length of 11 so the scheme-only string
  // `https://` (8 chars, no host) is rejected — it satisfies the prefix
  // check but is an integrity defect, not XSS (security-reviewer PR
  // #199 round 2 L1). 11 covers `https://a.b` and anything shorter
  // cannot be a valid primary source.
  source_url: z
    .string()
    .max(2000, 'source_url exceeds 2000 chars.')
    .refine((v) => v === '' || (v.startsWith('https://') && v.length >= 11), {
      message: 'source_url must be empty or a valid https:// URL (min length 11)',
    }),
  posture: FactExplainerPostureSchema,
});
type FactExplainerOutput = z.infer<typeof FactExplainerSchema>;

/** Projected USD cost for one drop_headline_rewrite call. Sonnet 4.6
 *  pricing × short input + short output ≈ $0.002. The cost ledger
 *  asserts under this projection before invoking; failures stamp the
 *  real spend per the ai-fabric contract. */
const REWRITE_PROJECTED_USD = 0.005;

/** Projected USD cost for one topic_fact_explainer call. Sonnet 4.6 +
 *  slightly longer output than headline rewrite (two paragraphs vs. a
 *  headline+summary+claim). ~$0.004. */
const EXPLAINER_PROJECTED_USD = 0.005;

/** How far back the cluster-block lookup reaches. 2 days back + today
 *  = the 3-consecutive-day window from the founder spec ("today + next 2
 *  days excluded"). */
const CLUSTER_BLOCK_DAYS = 2;

/** Confidence threshold for auto_dominant: chosen.score must exceed
 *  this multiple of the runner-up's score. */
const DOMINANCE_RATIO = 2.0;

/** PR C: max news-type URLs tried per reputable candidate before
 *  moving on to the next candidate. Matches the operator spec in
 *  drop-source-text-fetch.ts L204-206. */
const PER_CANDIDATE_TEXT_FETCH_ATTEMPTS = 3;

function aiErrorDigest(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.code}:${i.path.join('.') || '<root>'}`).join(', ');
  }
  return scrubMessage(err instanceof Error ? err.message : String(err));
}

// Match the sanitize-field pattern from fact-explainer.ts / drop-
// headline.ts verbatim: same codepoint coverage AND the same
// `new RegExp(string)` form so Prettier can't collapse the \uXXXX
// escapes into literal invisible characters inside the regex literal.

const CLAIM_STRIP_CONTROL_PATTERN =
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]';
const CLAIM_STRIP_CONTROL_RE = new RegExp(CLAIM_STRIP_CONTROL_PATTERN, 'g');
const CLAIM_STRIP_TAG_BLOCK_RE = new RegExp('[\\uDB40][\\uDC00-\\uDC7F]', 'g');

function sanitizeClaimContextField(raw: string): string {
  const stripControl = raw.replace(CLAIM_STRIP_CONTROL_RE, ' ');
  const stripTags = stripControl.replace(CLAIM_STRIP_TAG_BLOCK_RE, ' ');
  return stripTags.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

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
  const ranked = [...opts.candidates].sort((a, b) => b.rank_score - a.rank_score);

  let chosen: ActiveCandidate | undefined;
  for (const c of ranked) {
    if (!opts.blockedClusters.has(c.dedup_cluster_id)) {
      chosen = c;
      break;
    }
  }
  let blockExhausted = false;
  if (!chosen) {
    chosen = ranked[0]!;
    blockExhausted = true;
  }

  const runnerUp = ranked.find((c) => c.dedup_cluster_id !== chosen!.dedup_cluster_id) ?? null;

  return { chosen, runnerUp, blockExhausted };
}

/**
 * Apply the confidence threshold to decide curation_mode.
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

/** Today's 20:00 ET as ISO timestamp. */
export function todayDropAtEt(now: Date): string {
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
  const isoLocalEt = `${get('year')}-${get('month')}-${get('day')}T20:00:00`;
  const etOffsetMs = etOffsetMsAt(isoLocalEt);
  const utcMs = Date.parse(`${isoLocalEt}Z`) - etOffsetMs;
  return new Date(utcMs).toISOString();
}

function etOffsetMsAt(etWallClockIso: string): number {
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
// PR C — picked-source normalization. Primary/direct uses the candidate's
// own URL + title/summary. Reputable uses the fetched news-type outlet's
// URL + og:title + og:description.
// ---------------------------------------------------------------------------

interface PickedSource {
  /** The URL that will be stamped as `news_topics.primary_source_url`. */
  readonly url: string;
  /** The host for the picked URL (used in logging + telemetry). */
  readonly host: string;
  /** The title that feeds the headline rewrite + fact explainer. */
  readonly title: string;
  /** The description/summary input to the rewrite + fact explainer. */
  readonly summary: string | null;
  /** True iff the URL came from a GDELT cluster news-type outlet
   *  (reputable path), false if it's the candidate's own source_url
   *  (primary/direct path). */
  readonly fromClusterOutletFetch: boolean;
}

function pickedFromCandidate(c: ActiveCandidate): PickedSource {
  return {
    url: c.source_url,
    host: c.source_host,
    title: c.source_title,
    summary: c.summary,
    fromClusterOutletFetch: false,
  };
}

function pickedFromText(text: DropTextSource): PickedSource {
  return {
    url: text.url,
    host: text.host,
    title: text.title,
    summary: text.description,
    fromClusterOutletFetch: true,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const dropPublishHandler: JobHandler = async (row, deps) => {
  const now = new Date();

  // (1) Fetch Drop-eligible candidates via the SECURITY DEFINER RPC
  //     that enforces S3 (migration 20261019000000).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: candData, error: candErr } = (await (deps.supabase as any).rpc(
    'pick_drop_eligible_candidates',
    {},
  )) as { data: ActiveCandidate[] | null; error: { message: string } | null };
  if (candErr) throw new Error(`drop_publish: fetch candidates: ${scrubMessage(candErr.message)}`);
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
  if (blockedErr)
    throw new Error(`drop_publish: fetch blocked clusters: ${scrubMessage(blockedErr.message)}`);
  const blockedClusters = new Set((blockedData ?? []).map((r) => r.dedup_cluster_id));

  // (3) Walk ranked candidates, honoring blocked set. Reputable candidates
  //     must yield readable news-type outlet text; if none, skip to next.
  //     On full exhaustion of the unblocked pool, pass B tries the
  //     entire pool regardless of block state (§5 "never skip a day").
  const walkResult = await walkCandidates(deps, candidates, blockedClusters, false);
  const picked = walkResult ?? (await walkCandidates(deps, candidates, blockedClusters, true));

  if (!picked) {
    await stampPayload(deps, row.id, { ...row.payload, no_candidates: true });
    deps.logger.warn({ event: 'drop_publish.no_eligible_candidate', jobId: row.id });
    return;
  }

  const { chosen, runnerUp, blockExhausted, source } = picked;
  const curationMode = decideCurationMode({
    chosenScore: chosen.rank_score,
    runnerUpScore: runnerUp ? runnerUp.rank_score : null,
  });

  // (6a) LLM rewrite — fed with the picked source's title/summary
  //      (fetched text for reputable; candidate fields for primary).
  const rewrite = await rewriteHeadlineSafely(deps, chosen, source);

  // (6b) Fact explainer (A4).
  const factExplainer = await generateFactExplainerSafely(deps, chosen, source);

  // (7) Promote to news_topics. primary_source_url is the picked source
  //     URL — fetched news-type outlet for reputable, candidate.source_url
  //     for primary/direct.
  const dropAt = todayDropAtEt(now);
  const slug = await generateSlug(deps, chosen, now);
  const finalHeadline = rewrite.headline.length > 0 ? rewrite.headline : source.title;
  const finalSummary = rewrite.summary.length > 0 ? rewrite.summary : source.summary;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: topicData, error: topicErr } = (await (deps.supabase as any)
    .from('news_topics')
    .insert({
      slug,
      headline: finalHeadline,
      source_title: chosen.source_title,
      summary: finalSummary,
      primary_source_url: source.url,
      category: chosen.source_category,
      published_at: chosen.source_published_at,
      drop_at: dropAt,
      is_drop: true,
      is_block_exhausted: blockExhausted,
      dedup_cluster_id: chosen.dedup_cluster_id,
      curation_mode: curationMode,
      additional_sources: [],
      fact_explainer: factExplainer,
      fact_explainer_generated_at: factExplainer === null ? null : now.toISOString(),
    })
    .select('id')
    .single()) as { data: { id: string } | null; error: { message: string } | null };
  if (topicErr || !topicData) {
    throw new Error(
      `drop_publish: insert news_topics: ${scrubMessage(topicErr?.message ?? 'no row')}`,
    );
  }

  // (8) Auto-fact-check enqueue.
  let factCheckEnqueued = false;
  const factCheckEnabled = process.env.FACT_CHECK_ENABLED === 'true';
  if (rewrite.claim.length > 0 && factCheckEnabled) {
    const claimContext = `${sanitizeClaimContextField(source.title)}\n${sanitizeClaimContextField(source.url)}`;
    factCheckEnqueued = await enqueueDropFactCheck(deps, {
      claimText: rewrite.claim,
      claimContext,
      refId: topicData.id,
      now,
    });
  } else if (rewrite.claim.length > 0 && !factCheckEnabled) {
    deps.logger.info({
      event: 'drop_publish.fact_check_gated_off',
      news_topic_id: topicData.id,
      reason: 'FACT_CHECK_ENABLED !== true',
    });
  }

  // (9) PR C: stamp the GDELT cluster so it can't be Dropped again. Only
  //     reputable candidates carry a global_event_id; primary/direct skip.
  let clusterStamped = false;
  if (chosen.evidence_tier === 'reputable' && chosen.global_event_id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: stampedData, error: stampErr } = (await (deps.supabase as any).rpc(
      'stamp_cluster_drop_published',
      { p_global_event_id: chosen.global_event_id, p_at: now.toISOString() },
    )) as { data: boolean | null; error: { message: string } | null };
    if (stampErr) {
      deps.logger.warn({
        event: 'drop_publish.cluster_stamp_failed',
        global_event_id: chosen.global_event_id,
        message: scrubMessage(stampErr.message),
      });
      // Non-fatal: news_topics was already inserted. A missed stamp risks
      // re-pick of the same cluster next tick; the follow-up read gate on
      // drop_published_at is a defense, not a sole guarantee.
    } else {
      clusterStamped = stampedData === true;
    }
  }

  // (10) Mark every candidate in the chosen cluster as selected_at=now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: markErr } = (await (deps.supabase as any)
    .from('news_topics_candidates')
    .update({ selected_at: now.toISOString() })
    .eq('dedup_cluster_id', chosen.dedup_cluster_id)
    .is('selected_at', null)) as { error: { message: string } | null };
  if (markErr) {
    deps.logger.warn({
      event: 'drop_publish.mark_selected_failed',
      message: scrubMessage(markErr.message),
    });
  }

  const outcome: DropOutcome = {
    chosen_candidate_id: chosen.id,
    chosen_cluster_id: chosen.dedup_cluster_id,
    chosen_score: chosen.rank_score,
    runner_up_cluster_id: runnerUp?.dedup_cluster_id ?? null,
    runner_up_score: runnerUp?.rank_score ?? null,
    score_ratio:
      runnerUp && runnerUp.rank_score > 0 ? chosen.rank_score / runnerUp.rank_score : null,
    curation_mode: curationMode,
    block_exhausted: blockExhausted,
    news_topic_id: topicData.id,
    headline_rewritten: rewrite.headline.length > 0,
    fact_check_enqueued: factCheckEnqueued,
    evidence_tier: chosen.evidence_tier,
    text_fetched: source.fromClusterOutletFetch,
    fetched_host: source.fromClusterOutletFetch ? source.host : null,
    cluster_stamped: clusterStamped,
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

interface WalkResult {
  chosen: ActiveCandidate;
  runnerUp: ActiveCandidate | null;
  blockExhausted: boolean;
  source: PickedSource;
}

/** PR C: walk ranked candidates and return the first publishable one.
 *  "Publishable" means: unblocked (unless blockExhaustedMode) AND
 *    - primary/direct candidates: always publishable, use candidate URL.
 *    - reputable candidates: must have a global_event_id AND the cluster
 *      must yield readable news-type outlet text via fetchFirstReadable.
 *  Returns null if no candidate is publishable under the given mode. */
async function walkCandidates(
  deps: Parameters<JobHandler>[1],
  candidates: ReadonlyArray<ActiveCandidate>,
  blockedClusters: ReadonlySet<string>,
  blockExhaustedMode: boolean,
): Promise<WalkResult | null> {
  const ranked = [...candidates].sort((a, b) => b.rank_score - a.rank_score);
  for (const chosen of ranked) {
    if (!blockExhaustedMode && blockedClusters.has(chosen.dedup_cluster_id)) continue;
    if (chosen.evidence_tier === 'primary' || chosen.evidence_tier === 'direct') {
      const runnerUp = ranked.find((c) => c.dedup_cluster_id !== chosen.dedup_cluster_id) ?? null;
      return {
        chosen,
        runnerUp,
        blockExhausted: blockExhaustedMode,
        source: pickedFromCandidate(chosen),
      };
    }
    // Reputable path: require readable news-type outlet text.
    if (!chosen.global_event_id) {
      deps.logger.warn({
        event: 'drop_publish.reputable_candidate_without_global_event_id',
        candidateId: chosen.id,
      });
      continue;
    }
    const text = await tryFetchReputableText(deps, chosen);
    if (text === null) {
      deps.logger.info({
        event: 'drop_publish.reputable_candidate_text_unavailable',
        candidateId: chosen.id,
        globalEventId: chosen.global_event_id,
      });
      continue;
    }
    const runnerUp = ranked.find((c) => c.dedup_cluster_id !== chosen.dedup_cluster_id) ?? null;
    return {
      chosen,
      runnerUp,
      blockExhausted: blockExhaustedMode,
      source: pickedFromText(text),
    };
  }
  return null;
}

/** Load a reputable candidate's GDELT cluster outlets + best_news_url,
 *  rank them via pickTextSources, and fetch the first readable one. */
async function tryFetchReputableText(
  deps: Parameters<JobHandler>[1],
  candidate: ActiveCandidate,
): Promise<DropTextSource | null> {
  if (!candidate.global_event_id) return null;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    deps.logger.warn({
      event: 'drop_publish.no_fetch_impl',
      candidateId: candidate.id,
    });
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: clusterData, error: clusterErr } = (await (deps.supabase as any)
    .from('gdelt_event_cluster')
    .select('best_news_url, best_news_host')
    .eq('global_event_id', candidate.global_event_id)
    .maybeSingle()) as {
    data: { best_news_url: string | null; best_news_host: string | null } | null;
    error: { message: string } | null;
  };
  if (clusterErr) {
    deps.logger.warn({
      event: 'drop_publish.cluster_fetch_failed',
      candidateId: candidate.id,
      message: scrubMessage(clusterErr.message),
    });
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: outletData, error: outletErr } = (await (deps.supabase as any)
    .from('gdelt_event_cluster_outlet')
    .select('url, host, outlet_type')
    .eq('global_event_id', candidate.global_event_id)) as {
    data: GdeltClusterOutletRow[] | null;
    error: { message: string } | null;
  };
  if (outletErr) {
    deps.logger.warn({
      event: 'drop_publish.outlet_fetch_failed',
      candidateId: candidate.id,
      message: scrubMessage(outletErr.message),
    });
    return null;
  }
  const outlets = outletData ?? [];
  const sources = pickTextSources(
    outlets,
    clusterData?.best_news_url ?? null,
    clusterData?.best_news_host ?? null,
  );
  if (sources.length === 0) return null;
  return fetchFirstReadable(fetchImpl, sources, PER_CANDIDATE_TEXT_FETCH_ATTEMPTS);
}

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

/** Call the ai-fabric drop_headline_rewrite task.
 *  PR C: now takes a PickedSource (fetched text for reputable;
 *  candidate fields for primary/direct). */
async function rewriteHeadlineSafely(
  deps: Parameters<JobHandler>[1],
  candidate: ActiveCandidate,
  source: PickedSource,
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
        sourceTitle: source.title,
        sourceUrl: source.url,
        sourceHost: source.host,
        sourceCategory: candidate.source_category,
        sourceSummary: source.summary,
      }),
      schema: DropHeadlineRewriteSchema,
      env: deps.providerEnv ?? { xaiAvailable: false, perplexityAvailable: false },
      projectedUsd: REWRITE_PROJECTED_USD,
      maxTokens: 512,
    });
    return result.output as DropHeadlineRewriteOutput;
  } catch (err) {
    const issueDigest = aiErrorDigest(err);
    deps.logger.warn({
      event: 'drop_publish.rewrite_failed',
      candidateId: candidate.id,
      issueDigest,
    });
    void deps.alerter?.alert(
      'error',
      'drop_publish rewrite_failed',
      `candidate=${candidate.id} · see workers log for message`,
      {
        dedupKey: 'ai:rewrite_failed:drop_headline_rewrite',
        dedupTtlMs: 60 * 60_000,
      },
    );
    return empty;
  }
}

/** Call the ai-fabric topic_fact_explainer task (A4).
 *  PR C: now takes a PickedSource. */
async function generateFactExplainerSafely(
  deps: Parameters<JobHandler>[1],
  candidate: ActiveCandidate,
  source: PickedSource,
): Promise<FactExplainerOutput | null> {
  if (!deps.invoke) {
    deps.logger.warn({
      event: 'drop_publish.fact_explainer_skipped',
      reason: 'no_invoke',
      candidateId: candidate.id,
    });
    return null;
  }
  try {
    const result = await deps.invoke({
      task: 'topic_fact_explainer',
      system: TOPIC_FACT_EXPLAINER_SYSTEM_PROMPT,
      user: buildTopicFactExplainerUserPrompt({
        sourceTitle: source.title,
        sourceUrl: source.url,
        sourceHost: source.host,
        sourceCategory: candidate.source_category,
        sourceSummary: source.summary,
      }),
      schema: FactExplainerSchema,
      env: deps.providerEnv ?? { xaiAvailable: false, perplexityAvailable: false },
      projectedUsd: EXPLAINER_PROJECTED_USD,
      maxTokens: 1024,
    });
    const output = result.output as FactExplainerOutput;
    if (output.for_summary.trim().length === 0) {
      deps.logger.info({
        event: 'drop_publish.fact_explainer_empty',
        candidateId: candidate.id,
        posture: output.posture,
      });
      return null;
    }
    return output;
  } catch (err) {
    const issueDigest = aiErrorDigest(err);
    deps.logger.warn({
      event: 'drop_publish.fact_explainer_failed',
      candidateId: candidate.id,
      issueDigest,
    });
    void deps.alerter?.alert(
      'error',
      'drop_publish fact_explainer_failed',
      `candidate=${candidate.id} · see workers log for message`,
      {
        dedupKey: 'ai:failed:topic_fact_explainer',
        dedupTtlMs: 60 * 60_000,
      },
    );
    return null;
  }
}

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
      message: scrubMessage(upsertErr.message),
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
      message: scrubMessage(selectErr?.message ?? 'no row'),
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
    if (jobErr.code === '23505') return false;
    deps.logger.warn({
      event: 'drop_publish.fact_check_enqueue_failed',
      message: scrubMessage(jobErr.message),
    });
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
  PER_CANDIDATE_TEXT_FETCH_ATTEMPTS,
  sanitizeClaimContextField,
  factExplainerSafeParse: (value: unknown) => FactExplainerSchema.safeParse(value),
};
