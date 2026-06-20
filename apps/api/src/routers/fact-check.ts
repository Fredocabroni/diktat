// Fact-check tRPC router (PR 4.7).
//
// Two procedures:
//   enqueue({ refType, refId, claimText, claimContext })
//     - Computes dedup_hash = sha256(claim_text + '\n---\n' + claim_context)
//     - Upserts into fact_check_claims (idempotent on dedup_hash)
//     - Inserts into scheduled_jobs with job_type='fact_check'
//     - idempotency_key = '{claim_id}:{UTC YYYY-MM-DD}' so a daily
//       re-enqueue is possible across the 24h dedup TTL boundary
//   getVerdict({ claimId })
//     - Reads the most-recent verdict + its sources via user-scoped RLS
//       (read-all to authenticated per the schema design)
//     - Returns null when no verdict has settled yet
//
// Writes route through the service-role client because:
//   - fact_check_claims has RLS read-all but no insert policy
//   - scheduled_jobs has RLS disabled-but-no-policies (service_role only)
//     by PR #25's scheduler spine
// The user's identity is captured in fact_check_claims.created_by via
// ctx.userId.

import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { aiSpendLimit, queryLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';
import { serviceRoleClient } from '../supabase.js';

const enqueueInput = z
  .object({
    refType: z.enum(['news_topic', 'debate_argument', 'manual']),
    refId: z.string().uuid().nullable().optional(),
    claimText: z.string().min(10).max(4000),
    claimContext: z.string().max(2000).optional(),
  })
  .refine((v) => v.refType === 'manual' || (typeof v.refId === 'string' && v.refId.length > 0), {
    message: 'refId is required when refType is news_topic or debate_argument',
    path: ['refId'],
  });

const getVerdictInput = z.object({
  claimId: z.string().uuid(),
});

function dedupHashFor(claimText: string, claimContext: string): string {
  return createHash('sha256').update(`${claimText}\n---\n${claimContext}`).digest('hex');
}

function utcDayStamp(now: Date = new Date()): string {
  // YYYY-MM-DD in UTC.
  return now.toISOString().slice(0, 10);
}

export const factCheckRouter = router({
  enqueue: protectedProcedure
    // M5 — AI-spend tier. Each call enqueues a fact_check job that
    // costs $0.05–0.20 in AI spend. Budget: 20/day per userId
    // (TBD-pending-product-decision in TYRION_BUILD_QUEUE) + 3/min
    // burst to prevent a single user bursting the orchestrator at
    // midnight UTC. Fails-CLOSED on Redis outage: better to 429 than
    // leak $1+ during the outage window.
    .use(aiSpendLimit('factCheck.enqueue', { daily: 20, burst: 3 }))
    .input(enqueueInput)
    .mutation(async ({ ctx, input }) => {
      const claimContext = input.claimContext ?? '';
      const dedupHash = dedupHashFor(input.claimText, claimContext);

      // Service-role client: writes to fact_check_claims + scheduled_jobs
      // both require it (RLS does not allow user-side INSERT on either).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = serviceRoleClient(ctx.env) as any;

      // 1) Upsert claim with ignoreDuplicates — if the hash already exists,
      //    no row is rewritten. Then SELECT to recover the id whether the
      //    INSERT happened or the row pre-existed.
      const { error: upsertErr } = await service.from('fact_check_claims').upsert(
        {
          claim_text: input.claimText,
          claim_context: claimContext,
          dedup_hash: dedupHash,
          ref_type: input.refType,
          ref_id: input.refId ?? null,
          created_by: ctx.userId,
        },
        { onConflict: 'dedup_hash', ignoreDuplicates: true },
      );
      if (upsertErr) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to upsert fact-check claim.',
          cause: upsertErr,
        });
      }

      const { data: claimRow, error: selectErr } = await service
        .from('fact_check_claims')
        .select('id')
        .eq('dedup_hash', dedupHash)
        .maybeSingle();
      if (selectErr || !claimRow) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read back fact-check claim id.',
          cause: selectErr,
        });
      }
      const claimId = claimRow.id as string;

      // 2) Enqueue a fact_check job. idempotency_key = '{claim_id}:{UTC_day}'
      //    so a same-day re-enqueue is a no-op (the orchestrator will cache-
      //    hit anyway), but a next-UTC-day re-enqueue is allowed.
      const idempotencyKey = `${claimId}:${utcDayStamp()}`;
      const { error: jobErr } = await service.from('scheduled_jobs').insert({
        job_type: 'fact_check',
        idempotency_key: idempotencyKey,
        payload: {
          claim_id: claimId,
          enqueued_at: new Date().toISOString(),
        },
      });
      // 23505 = unique_violation on (job_type, idempotency_key). That's a
      // same-day duplicate enqueue — accept silently and return the claim.
      if (jobErr && jobErr.code !== '23505') {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to enqueue fact-check job.',
          cause: jobErr,
        });
      }

      return {
        claimId,
        idempotencyKey,
        queued: jobErr?.code !== '23505',
      };
    }),

  getVerdict: protectedProcedure
    // M5.1 — 30/min per user. Defensive cap: zero client callers in
    // `apps/web/` as of this PR. Revisit the budget when a UI consumer
    // lands (probably DropCard's fact-check verdict chip).
    .use(queryLimit('factCheck.getVerdict', { perMin: 30 }))
    .input(getVerdictInput)
    .query(async ({ ctx, input }) => {
      // User-scoped client: RLS allows read-all to authenticated on all three
      // tables (the transparency contract per MASTER_PLAN §1).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = (await (ctx.db as any)
        .from('fact_check_verdicts')
        .select(
          'id, claim_id, verdict, confidence, reason, contested_reason, model, route, retrieval_mode, cost_usd, settled_at, fact_check_sources(url, label, fetch_status, snippet, position)',
        )
        .eq('claim_id', input.claimId)
        .order('settled_at', { ascending: false })
        .limit(1)
        .maybeSingle()) as { data: VerdictRow | null; error: { message: string } | null };

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read verdict.',
          cause: error,
        });
      }
      return data;
    }),
});

export interface VerdictRow {
  readonly id: string;
  readonly claim_id: string;
  readonly verdict: 'supported' | 'refuted' | 'mixed' | 'unverifiable' | 'contested';
  readonly confidence: number;
  readonly reason: string;
  readonly contested_reason: string | null;
  readonly model: string;
  readonly route: string;
  readonly retrieval_mode: 'none' | 'perplexity';
  readonly cost_usd: number | null;
  readonly settled_at: string;
  readonly fact_check_sources: ReadonlyArray<{
    url: string;
    label: string;
    fetch_status: 'pass' | 'advisory_pass' | 'reject' | 'skipped';
    snippet: string | null;
    position: number;
  }>;
}
