// Trivia question generation pipeline.
//
// Two-AI consensus design (per MASTER_PLAN.md §4):
//   1. Generator: Sonnet 4.6 produces a batch of trivia drafts in a
//      structured Zod shape. Routing falls back to GPT-5 if Sonnet
//      errors out the chain.
//   2. Verifier: a second invoke targets `sourced_factcheck`, which
//      routes to Perplexity Sonar (when its key is set) or Claude Opus
//      with extended thinking otherwise — DIFFERENT model family from
//      the generator so the verifier can't agree with its own
//      hallucination.
//   3. Source URL HEAD check: must return 200 OK or the draft is
//      auto-rejected regardless of AI consensus.
//
// `verified=true` is set only when the verifier agrees with the
// generator's `correct_index` AND the confidence is >= 0.75 AND the
// HEAD check passes. Unverified drafts still write but with
// `verified=false`; RLS hides them from clients (see migration 0004).
//
// Convention: `verified_by_user_id IS NULL AND verified = true` means
// "AI-consensus auto-approved". A future migration can add an
// enum-typed `verified_by` column when human-mod tooling lands; the
// existing column stays the source of truth for human approvals.

import type { ServiceClient } from '../supabase.js';
import type { Logger } from '../logger.js';
import type { invoke as fabricInvoke, ProviderEnv } from '@diktat/ai-fabric';
import { z } from 'zod';

const QuestionDraftSchema = z.object({
  prompt: z.string().min(20).max(500),
  choices: z.array(z.string().min(1).max(200)).length(4),
  correct_index: z.number().int().min(0).max(3),
  difficulty: z.number().int().min(1).max(10),
  source_url: z.string().url(),
  source_label: z.string().min(1).max(100),
});
type QuestionDraft = z.infer<typeof QuestionDraftSchema>;

const QuestionBatchSchema = z.object({
  questions: z.array(QuestionDraftSchema).min(1).max(100),
});

const VerifyResultSchema = z.object({
  agrees: z.boolean(),
  confidence: z.number().min(0).max(1),
  // No length cap — `reason` is logged for observability then discarded,
  // never persisted. A cap here only risks a ZodError that silently turns
  // a valid verdict into a rejection (see the verifyOne catch block).
  reason: z.string(),
});

export interface TriviaGenInput {
  readonly category: string;
  readonly count: number;
  /** Inclusive [min, max] range, both 1..10. */
  readonly difficultyBand: readonly [number, number];
}

export interface TriviaGenDeps {
  readonly invoke: typeof fabricInvoke;
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  /** Defaults to globalThis.fetch; injected for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Provider availability snapshot. Defaults to all-stable-keys-set. */
  readonly providerEnv?: ProviderEnv;
}

export interface TriviaGenResult {
  readonly generated: number;
  readonly verified: number;
  readonly rejected: number;
  readonly failed: number;
}

const GENERATOR_USD_PER_QUESTION = 0.005;
const VERIFIER_USD_PER_QUESTION = 0.003;
const VERIFY_CONFIDENCE_FLOOR = 0.75;

/**
 * Generate, verify, and persist a batch of trivia questions for one
 * category + difficulty band. Idempotent at the AI level (each call
 * generates fresh drafts) but NOT at the storage level — running this
 * twice with the same input produces two distinct row sets. The seed
 * script handles dedupe via prompt-hash before insert when needed.
 */
export async function runTriviaGen(
  input: TriviaGenInput,
  deps: TriviaGenDeps,
): Promise<TriviaGenResult> {
  const { invoke, supabase, logger } = deps;
  const fetch = deps.fetch ?? globalThis.fetch;
  const providerEnv: ProviderEnv = deps.providerEnv ?? {
    xaiAvailable: false,
    perplexityAvailable: false,
  };

  const [minDiff, maxDiff] = input.difficultyBand;
  const projectedGenerator = GENERATOR_USD_PER_QUESTION * input.count;

  logger.info({
    event: 'trivia.gen.start',
    category: input.category,
    count: input.count,
    difficultyBand: input.difficultyBand,
  });

  const generatorSystem = `You are a Diktat trivia generator. Produce political-civics trivia questions sourced from primary sources only (no MSM as truth source). Each question must have exactly 4 choices, one correct, difficulty between ${minDiff} and ${maxDiff} on a 1-10 scale, and a real primary-source URL on .gov, .org govtrack/ballotpedia/opensecrets, c-span.org, or fred.stlouisfed.org. The source must directly substantiate the correct answer.`;
  const generatorUser = `Generate exactly ${input.count} trivia questions in the "${input.category}" category. Return JSON matching the schema {"questions":[{"prompt","choices","correct_index","difficulty","source_url","source_label"}]}.`;

  let generated: QuestionDraft[];
  try {
    const result = await invoke({
      task: 'trivia_gen',
      system: generatorSystem,
      user: generatorUser,
      schema: QuestionBatchSchema,
      env: providerEnv,
      projectedUsd: projectedGenerator,
      maxTokens: 4096,
    });
    generated = (result.output as z.infer<typeof QuestionBatchSchema>).questions;
  } catch (err) {
    logger.error({
      event: 'trivia.gen.generator_failed',
      category: input.category,
      message: err instanceof Error ? err.message : String(err),
    });
    return { generated: 0, verified: 0, rejected: 0, failed: input.count };
  }

  let verified = 0;
  let rejected = 0;
  let failed = 0;

  for (const draft of generated) {
    const verdict = await verifyOne(draft, {
      invoke,
      providerEnv,
      fetch,
      logger,
    });

    const row: TriviaQuestionInsert = {
      category: input.category,
      prompt: draft.prompt,
      choices: draft.choices,
      correct_index: draft.correct_index,
      difficulty: draft.difficulty,
      source_url: draft.source_url,
      verified: verdict.outcome === 'verified',
      verified_by_user_id: null,
    };

    const { error: insertErr } = (await supabase
      .from('trivia_questions')
      .insert(row)
      .select('id')
      .maybeSingle()) as { error: { message: string } | null };

    if (insertErr) {
      logger.error({
        event: 'trivia.gen.insert_failed',
        category: input.category,
        message: insertErr.message,
      });
      failed += 1;
      continue;
    }

    if (verdict.outcome === 'verified') verified += 1;
    else rejected += 1;
  }

  logger.info({
    event: 'trivia.gen.done',
    category: input.category,
    generated: generated.length,
    verified,
    rejected,
    failed,
  });

  return { generated: generated.length, verified, rejected, failed };
}

interface TriviaQuestionInsert {
  category: string;
  prompt: string;
  choices: string[];
  correct_index: number;
  difficulty: number;
  source_url: string;
  verified: boolean;
  verified_by_user_id: string | null;
}

interface VerifyOneDeps {
  invoke: typeof fabricInvoke;
  providerEnv: ProviderEnv;
  fetch: typeof globalThis.fetch;
  logger: Logger;
}

interface VerifyVerdict {
  outcome: 'verified' | 'rejected';
  reason:
    | 'ai_consensus'
    | 'ai_disagree'
    | 'low_confidence'
    | 'source_unreachable'
    | 'verifier_error';
}

// MASTER_PLAN.md §8 primary sources whose hosts are known to block automated
// HEAD probes (Akamai/CDN WAF rejects bare-fetch User-Agents) but are stable
// enough to skip the liveness gate. A wrong URL on these hosts will still get
// caught by the substance check (verifier model reads the URL).
// See CLAUDE.md "Phase 3.5 — HEAD-check whitelist".
const HEAD_CHECK_WHITELIST: ReadonlyArray<string> = [
  // §8 primary sources where Node fetch HEAD is unreliable from this network
  // (CDN-WAF blocks, IPv6 routing, slow handshake). The substance verifier
  // (Opus reads the URL) is the real correctness gate; HEAD is just a
  // liveness probe and these hosts are stable enough to skip it.
  'congress.gov',
  'www.congress.gov',
  'fred.stlouisfed.org',
  'www.federalreserve.gov',
  'federalreserve.gov',
  'www.bls.gov',
  'bls.gov',
  'www.fbi.gov',
  'fbi.gov',
  'www.cdc.gov',
  'cdc.gov',
  'www.sec.gov',
  'sec.gov',
  'www.dol.gov',
  'dol.gov',
  'www.defense.gov',
  'defense.gov',
  'home.treasury.gov',
  'www.supremecourt.gov',
  'supremecourt.gov',
  'www.census.gov',
  'census.gov',
  'www.cbo.gov',
  'cbo.gov',
  'www.justice.gov',
  'justice.gov',
];

function shouldSkipHeadCheck(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HEAD_CHECK_WHITELIST.includes(host);
  } catch {
    return false;
  }
}

/**
 * Walk an error's `cause` chain (Diktat errors forward `cause` to the native
 * Error). Returns `'schema_mismatch'` when any link is a Zod or Diktat
 * validation error — the model answered but our schema rejected it — versus
 * `'provider_error'` for transport / API / budget failures. Lets a seed
 * re-run self-validate: zero `schema_mismatch` rejections means the fix held.
 */
function classifyVerifierFailure(err: unknown): 'schema_mismatch' | 'provider_error' {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && cursor instanceof Error; depth++) {
    if (cursor.name === 'ZodError') return 'schema_mismatch';
    if ((cursor as { code?: unknown }).code === 'VALIDATION_FAILED') return 'schema_mismatch';
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return 'provider_error';
}

/** Deepest message in the cause chain — the real failure, not the wrapper. */
function rootCauseMessage(err: unknown): string {
  let cursor: unknown = err;
  let message = err instanceof Error ? err.message : String(err);
  for (let depth = 0; depth < 8 && cursor instanceof Error; depth++) {
    message = cursor.message;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return message;
}

async function verifyOne(draft: QuestionDraft, deps: VerifyOneDeps): Promise<VerifyVerdict> {
  // 1. HEAD-check the source URL. A 200 OK is required regardless of
  //    what the verifier model thinks — a broken citation can't
  //    substantiate the answer. Whitelisted hosts (CDN-WAF blocks bare
  //    fetches) skip this gate and rely on the substance verifier.
  let headOk = false;
  if (shouldSkipHeadCheck(draft.source_url)) {
    deps.logger.info({
      event: 'trivia.gen.head_skipped_whitelist',
      url: draft.source_url,
    });
    headOk = true;
  } else {
    try {
      const response = await deps.fetch(draft.source_url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      headOk = response.ok;
    } catch (err) {
      deps.logger.warn({
        event: 'trivia.gen.head_failed',
        url: draft.source_url,
        message: err instanceof Error ? err.message : String(err),
      });
      headOk = false;
    }
  }

  if (!headOk) {
    return { outcome: 'rejected', reason: 'source_unreachable' };
  }

  // 2. Verifier model. sourced_factcheck routes to Perplexity Sonar
  //    when available; otherwise Claude Opus with extended thinking.
  //    Both are different families from the Sonnet 4.6 generator.
  const verifierSystem =
    'You are a Diktat fact-checker. Confirm whether the provided claim — derived from a trivia question and its declared correct answer — is fully supported by the cited primary source. Return strict JSON with `agrees` (boolean), `confidence` (0..1), and `reason` (string).';
  const verifierUser = `Question: ${draft.prompt}\nDeclared correct answer (index ${draft.correct_index}): ${draft.choices[draft.correct_index]}\nSource: ${draft.source_url} (${draft.source_label})\n\nDoes the source substantiate that this is the correct answer?`;

  try {
    const result = await deps.invoke({
      task: 'sourced_factcheck',
      system: verifierSystem,
      user: verifierUser,
      schema: VerifyResultSchema,
      env: deps.providerEnv,
      projectedUsd: VERIFIER_USD_PER_QUESTION,
      maxTokens: 1024,
    });
    const verdict = result.output as z.infer<typeof VerifyResultSchema>;
    // Log every verdict's actual reason text + length. A re-run can grep
    // `reasonLength` to confirm reasons now flow past the old 500-char cap,
    // and `agrees: false` here marks a genuine model disagreement (distinct
    // from the schema/transport failures logged in the catch below).
    deps.logger.info({
      event: 'trivia.gen.verifier_verdict',
      url: draft.source_url,
      prompt: draft.prompt,
      agrees: verdict.agrees,
      confidence: verdict.confidence,
      reasonLength: verdict.reason.length,
      reason: verdict.reason,
    });
    if (!verdict.agrees) {
      return { outcome: 'rejected', reason: 'ai_disagree' };
    }
    if (verdict.confidence < VERIFY_CONFIDENCE_FLOOR) {
      return { outcome: 'rejected', reason: 'low_confidence' };
    }
    return { outcome: 'verified', reason: 'ai_consensus' };
  } catch (err) {
    // failureKind splits our-schema-rejected-a-valid-answer (`schema_mismatch`)
    // from a real provider/transport failure (`provider_error`). After the
    // reason-cap removal, `schema_mismatch` rejections should drop to zero.
    const failureKind = classifyVerifierFailure(err);
    deps.logger.warn({
      event: 'trivia.gen.verifier_failed',
      url: draft.source_url,
      failureKind,
      message: err instanceof Error ? err.message : String(err),
      detail: rootCauseMessage(err),
    });
    return { outcome: 'rejected', reason: 'verifier_error' };
  }
}

export const __testing = {
  QuestionDraftSchema,
  QuestionBatchSchema,
  VerifyResultSchema,
  VERIFY_CONFIDENCE_FLOOR,
};
