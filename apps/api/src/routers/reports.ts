// Content-reports router. Users submit a report via `reports.submit`;
// the write is behind the SECURITY DEFINER `public.submit_report` RPC
// (migration 20261112000000). Rows are visible to service_role only.
// After a successful insert we fire a Telegram alert so the operator
// sees new reports without hitting the DB — fire-and-forget, failures
// swallowed by the alerter (it has its own dedup + rate cap + onFailure
// logger), the user's report submits regardless of Telegram health.

import { TRPCError } from '@trpc/server';
import { makeAlerter, type Alerter } from '@diktat/shared/alerts';
import { z } from 'zod';

import type { Env } from '../env.js';
import { mutationLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';

// Target vocabulary — must stay in sync with the CHECK constraint on
// public.reports (migration 20261112000000). A new content surface
// lands here in the same PR as its UI call site. `debate_post` is
// intentionally omitted today; add it back together with the
// matching public.debate_posts table.
const TARGET_TYPES = ['debate_arg', 'drop', 'user'] as const;

// Module-level alerter instance. The alerter carries its own dedup +
// per-window rate cap, so a module-scope singleton is correct — a
// per-request alerter would reset those windows and could storm the
// operator chat. Lazily constructed on first use to avoid instantiating
// one on API boot before env is loaded.
let cachedAlerter: Alerter | null = null;
function getAlerter(env: Env): Alerter {
  if (cachedAlerter !== null) return cachedAlerter;
  cachedAlerter = makeAlerter({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  });
  return cachedAlerter;
}
// Exported for tests to reset the singleton between cases.
export function _resetReportsAlerterForTests(a: Alerter | null = null): void {
  cachedAlerter = a;
}

export const reportsRouter = router({
  submit: protectedProcedure
    .use(mutationLimit('reports.submit', { perMin: 5 }))
    .input(
      z.object({
        targetType: z.enum(TARGET_TYPES),
        targetId: z.string().uuid(),
        // 2000 char cap mirrors the DB CHECK. Trim at the edge so
        // the SQL CHECK only sees genuinely bad input.
        reason: z.string().trim().min(1, 'Say what you are reporting.').max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = (await (ctx.db as any).rpc('submit_report', {
        p_target_type: input.targetType,
        p_target_id: input.targetId,
        p_reason: input.reason,
      })) as {
        data: { outcome?: string; id?: string } | null;
        error: { code?: string; message?: string } | null;
      };
      if (error) {
        const code = error.code;
        const msg = error.message ?? '';
        // Sqlstate map (see migration 20261112000000):
        //   22023                         → BAD_REQUEST (bad reason / target_type)
        //   28000                         → UNAUTHORIZED (anon)
        //   P0001 'reports: rate_limited' → TOO_MANY_REQUESTS
        //   P0001 'reports: age_not_verified' → FORBIDDEN
        //   P0001 'reports: target_not_found' → NOT_FOUND
        //   anything else                 → INTERNAL_SERVER_ERROR
        if (code === '22023') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: "Report didn't save. Check the details and try again.",
            cause: new Error(code),
          });
        }
        if (code === '28000') {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Sign in required.',
            cause: new Error(code),
          });
        }
        if (code === 'P0001') {
          if (msg.includes('rate_limited')) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: 'Too many reports in the last hour. Try again later.',
              cause: new Error('rate_limited'),
            });
          }
          if (msg.includes('age_not_verified')) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Confirm your age before reporting content.',
              cause: new Error('age_not_verified'),
            });
          }
          if (msg.includes('target_not_found')) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: "We couldn't find that content.",
              cause: new Error('target_not_found'),
            });
          }
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: "Report didn't save. Try again.",
          cause: new Error(code ?? 'db_error'),
        });
      }
      const outcome = data?.outcome ?? 'submitted';
      const reportId = data?.id ?? null;

      // Fire-and-forget operator alert. The alerter is a no-op when
      // TELEGRAM_BOT_TOKEN/CHAT_ID are unset; its onFailure logger is
      // wired at construction time. We `void` the promise so the
      // user's happy path doesn't wait on Telegram. Dedup keyed on
      // target so a single reported post doesn't storm the operator
      // chat if it gets reported many times quickly.
      //
      // Data-minimisation posture (push 3/3): the alert body carries
      // report id + target type/id + a link only. Reason text is
      // deliberately NOT sent to Telegram — the operator reads the
      // reason from the service-role admin surface via the link.
      // Detail is plain text; the alerter sink owns all HTML escaping.
      const baseUrl = ctx.env.WEB_ORIGINS[0] ?? 'https://diktat.app';
      const link = reportId ? `${baseUrl}/admin/reports/${reportId}` : baseUrl;
      const alerter = getAlerter(ctx.env);
      void alerter.alert(
        'warn',
        'Content report',
        [
          `Target: ${input.targetType} / ${input.targetId}`,
          reportId ? `Report id: ${reportId}` : '',
          `Link: ${link}`,
        ]
          .filter(Boolean)
          .join('\n'),
        { dedupKey: `report:${input.targetType}:${input.targetId}` },
      );

      return {
        outcome: outcome as 'submitted' | 'already_reported',
        reportId,
      };
    }),
});
