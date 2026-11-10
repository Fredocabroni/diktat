// Feed router.
//
// `recordShift` mutation: writes one row to public.opinion_shifts. RLS policy
// `opinion_shifts_insert_self` (migration 0005) gates the user_id; the write
// goes through `ctx.db` (user-scoped) so the bearer token is the authority.
//
// Per-submit idempotency (#127 H11 PR B2): the client sends a per-tap uuid
// `clientKey`. It is stored on the inserted row. The partial unique index
// `opinion_shifts_user_client_key_uniq` on (user_id, client_key) added by
// migration 20260930000000 rejects a second write with the same pair,
// returning sqlstate `23505`. On that error the handler falls back to a
// self-scoped SELECT of the existing row (by user_id + client_key) and
// returns it as an ordinary success — a retry after a lost response looks
// the same to the caller as a first-time success. `NULL != NULL` in
// Postgres unique indexes so the partial predicate also lets multiple
// legitimate change-of-mind rows (different keys) coexist on the same
// (user_id, topic_id) — see docs/MASTER_PLAN.md:179.
//
// clientKey is OPTIONAL at the input layer during the rollout window:
// PWA users on stale cached bundles will keep sending requests without
// it. A missing key writes the row on the legacy path (no idempotency
// enforcement — same failure mode as before B2). A present-but-invalid
// key (non-UUID) is rejected at the schema layer. Once
// `opinion_shifts.client_key IS NOT NULL` for all recent rows in prod
// the field should be tightened to required — filed as a follow-up.
//
// `list` query: returns today's Drop (the news_topics row with is_drop=true
// whose drop_at has passed) or the most-recent past Drop if today's hasn't
// fired yet. Length ≤ 1 in default-input mode; forward-compatible with
// archive pagination via { limit, cursor }. RLS read-all is in place on
// news_topics via `news_topics_select_all` (migration 20260420090005:26).

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { mutationLimit, queryLimit } from '../rate-limit.js';
import { protectedProcedure, router } from '../trpc.js';

const positionSchema = z.number().int().min(-2).max(2);

const listInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(1),
    // ISO timestamp; rows returned have drop_at <= cursor. Default is the
    // current server time so the no-input call returns "the current Drop".
    // Rejected if it lies in the future — a `cursor=9999-…` call would
    // otherwise return any pre-populated future-dated row the moment
    // drop_publish lands it, before its drop_at arrives. The pipeline
    // today stamps drop_at at INSERT time, but a future curator path
    // (the curation_mode enum already accommodates it) is the kind of
    // writer this guard exists for. The handler also clamps server-side
    // (defense in depth against any future input-schema regression).
    cursor: z
      .string()
      .datetime()
      .optional()
      .refine((v) => v === undefined || Date.parse(v) <= Date.now(), {
        message: 'cursor must not be in the future',
      }),
  })
  .optional();

const TOPIC_SELECT =
  'id, headline, source_title, summary, primary_source_url, category, drop_at, dedup_cluster_id, curation_mode, is_block_exhausted, additional_sources, fact_explainer';

interface TopicRow {
  id: string;
  headline: string;
  source_title: string | null;
  summary: string | null;
  primary_source_url: string | null;
  category: string | null;
  drop_at: string | null;
  dedup_cluster_id: string | null;
  curation_mode: string | null;
  is_block_exhausted: boolean;
  additional_sources: unknown;
  // A4 (migration 20261012000000): nullable jsonb. Shape when non-null:
  // { for_summary, against_summary, source_url, posture }. See
  // packages/ai-fabric/src/prompts/fact-explainer.ts for the contract.
  fact_explainer: unknown;
}

/** Narrow + validate the fact_explainer JSON shape before returning
 *  to the client. Preserves the fail-tolerant posture — a malformed
 *  stored payload reads as null (UI falls through to raw source link).
 *
 *  Scheme + length enforcement at read time (security-reviewer PR #198
 *  HIGH #2 + MEDIUM #2): the write path enforces these via the Zod
 *  schema in drop-publish.ts and the DB CHECK constraint in migration
 *  20261012010000, but a direct psql insert or future looser code path
 *  must not punch through the read-side defenses. source_url MUST be
 *  empty or begin with https:// — never javascript:, data:, or http:.
 *  Lengths mirror the write-side caps (1000/1000/2000). */
const FACT_EXPLAINER_FOR_SUMMARY_MAX = 1000;
const FACT_EXPLAINER_AGAINST_SUMMARY_MAX = 1000;
const FACT_EXPLAINER_SOURCE_URL_MAX = 2000;

function parseFactExplainer(raw: unknown): {
  readonly for_summary: string;
  readonly against_summary: string;
  readonly source_url: string;
  readonly posture: 'contested' | 'single_sided' | 'empirical';
} | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const forSummary = typeof obj.for_summary === 'string' ? obj.for_summary : '';
  const againstSummary = typeof obj.against_summary === 'string' ? obj.against_summary : '';
  const sourceUrl = typeof obj.source_url === 'string' ? obj.source_url : '';
  const posture = obj.posture;
  if (forSummary.length === 0) return null;
  if (posture !== 'contested' && posture !== 'single_sided' && posture !== 'empirical') {
    return null;
  }
  // Length guards — mirror write-side caps. Reject-on-exceed (not
  // silent-truncate) surfaces DB-integrity drift early.
  if (forSummary.length > FACT_EXPLAINER_FOR_SUMMARY_MAX) return null;
  if (againstSummary.length > FACT_EXPLAINER_AGAINST_SUMMARY_MAX) return null;
  if (sourceUrl.length > FACT_EXPLAINER_SOURCE_URL_MAX) return null;
  // Scheme guard — never return a non-https URL that DropCard would
  // render inside an anchor. Empty source_url is valid (upstream null-
  // on-failure); any non-empty value must be https:// AND have a host
  // (min length 11 covers `https://a.b`) — security-reviewer PR #199
  // round 2 L1: `https://` alone is a scheme-only integrity defect.
  if (sourceUrl.length > 0 && (!sourceUrl.startsWith('https://') || sourceUrl.length < 11)) {
    return null;
  }
  return {
    for_summary: forSummary,
    against_summary: againstSummary,
    source_url: sourceUrl,
    posture,
  };
}

export const feedRouter = router({
  recordShift: protectedProcedure
    // M5 — 10/min per user. One stance per Drop in practice; 10/min
    // is the anti-bot floor.
    //
    // The outer mutationLimit stays — it is the per-process ceiling that
    // throttles a flooding client at the tRPC boundary. The RPC's own
    // rolling-24h cap (migration 20261010000000, PR A of #145) is a
    // defence-in-depth atomic ceiling INSIDE the DB transaction, serialized
    // per-user via pg_advisory_xact_lock so parallel bursts cannot slip
    // through between the COUNT and the INSERT.
    .use(mutationLimit('feed.recordShift', { perMin: 10 }))
    .input(
      z.object({
        topicId: z.string().uuid(),
        afterPosition: positionSchema,
        // Per-tap idempotency key generated by the client. See file
        // header. Optional during the rollout window so stale-PWA
        // clients continue to succeed. A present-but-invalid value is
        // still rejected — `.uuid()` runs whenever the field is passed.
        clientKey: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // #145 PR B: the write runs through `record_opinion_shift(uuid,
      // smallint, uuid)` — a SECURITY DEFINER RPC that derives user_id
      // from auth.uid(), snapshots before_position server-side (replacing
      // the H13 pre-select below), enforces a rolling-24h cap, and
      // ON CONFLICT no-ops the Take 5 after-insert trigger on retry. The
      // RPC returns the opinion_shifts row either freshly inserted or
      // pre-existing from an idempotent retry — identical wire shape to
      // the previous .insert() path.
      //
      // PR A of #145 (migration 20261010000000) landed the RPC; PR C
      // drops the client-side `opinion_shifts_insert_self` policy, at
      // which point this is the only writer and the RPC's cap + snapshot
      // guarantees cannot be bypassed via direct PostgREST.
      const { data, error } = await ctx.db.rpc('record_opinion_shift', {
        p_topic_id: input.topicId,
        p_after_position: input.afterPosition,
        p_client_key: input.clientKey ?? undefined,
      });

      if (error) {
        // Map RPC SQLSTATE → tRPC code. Each raise in the RPC uses a
        // specific code so the client (and the mutationLimit middleware)
        // can distinguish retryable from terminal. The `cause` carries
        // only the SQLSTATE so the raw PostgrestError's
        // message/details/hint (which can carry schema/constraint names
        // or raised-exception text) never reaches the tRPC wire
        // response — same wire-safety wrap as the pre-RPC path.
        const code = error.code;
        if (code === 'P0002') {
          // topic not found — client should clear the card from its
          // local queue without retrying.
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Topic not found.' });
        }
        if (code === '54000') {
          // rolling-24h cap hit. TOO_MANY_REQUESTS classifies the
          // response for consistent client-side retry logic.
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many opinion shifts in the last 24 hours.',
            cause: new Error(code),
          });
        }
        if (code === '22023') {
          // after_position out of range — client bug. BAD_REQUEST so
          // the fetch is not retried.
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid stance.',
            cause: new Error(code),
          });
        }
        if (code === '28000') {
          // auth.uid() came back null inside the RPC. Should be
          // unreachable from protectedProcedure (which 401s before any
          // handler body), but defence-in-depth classification.
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Not authenticated.',
            cause: new Error(code),
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record opinion shift.',
          cause: new Error(code ?? 'db_error'),
        });
      }

      if (!data) {
        // The RPC's return type is a composite row; a null result here
        // would mean supabase-js dropped the payload. Prefer
        // INTERNAL_SERVER_ERROR over silently fabricating a success.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record opinion shift.',
          cause: new Error('rpc_null_result'),
        });
      }

      return {
        id: data.id,
        topicId: data.topic_id,
        beforePosition: data.before_position,
        afterPosition: data.after_position,
        createdAt: data.created_at,
      };
    }),

  list: protectedProcedure
    // M5.1 — 60/min per user. Cold read (no client polling), single
    // call site (DropFeedClient on home). 1 DB query. Generous cap
    // for the home-page rapid-navigation case.
    .use(queryLimit('feed.list', { perMin: 60 }))
    .input(listInputSchema)
    .query(async ({ ctx, input }) => {
      // Belt-and-suspenders future-clamp: the input schema already
      // rejects future cursors, but a server-side Math.min closes the
      // window against any later input-schema regression.
      const requestedCursorMs = input?.cursor ? Date.parse(input.cursor) : Date.now();
      const cursor = new Date(Math.min(requestedCursorMs, Date.now())).toISOString();
      const limit = input?.limit ?? 1;

      const { data, error } = (await ctx.db
        .from('news_topics')
        .select(TOPIC_SELECT)
        .eq('is_drop', true)
        .lte('drop_at', cursor)
        .order('drop_at', { ascending: false })
        .limit(limit)) as unknown as {
        data: TopicRow[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load Drop.',
          cause: error,
        });
      }

      const topicRows = data ?? [];
      const topicIds = topicRows.map((row) => row.id);

      // Per-user latest-stance lookup for P2.a. ONE query per topic,
      // each capped to the latest row via .limit(1).maybeSingle() so
      // the fetch is strictly bounded regardless of how many historical
      // shifts a user has on a topic. Uses the composite index on
      // (user_id, topic_id, created_at desc) from migration
      // 20260420090011. Earlier draft used a single
      // `.in('topic_id', topicIds)` query with no LIMIT — flagged by
      // security review on #196 as an unbounded fetch (a user with
      // 1000 historical shifts on topic A would pull all 1000 just to
      // read the latest). The parallel-maybeSingle shape avoids that.
      //
      // Non-fatal on error — a stance-lookup failure for one topic
      // falls through to a `null` stance for that topic and the
      // DropCard shows neutral buttons. Error log carries the PG
      // error code (short, enum-like) rather than the message
      // (which can echo UUIDs or query text — security-reviewer
      // PR #196 Low 2).
      const latestStance: Record<string, 'agree' | 'disagree' | null> = {};
      if (topicIds.length > 0) {
        await Promise.all(
          topicIds.map(async (topicId) => {
            const { data: shift, error: shiftErr } = (await ctx.db
              .from('opinion_shifts')
              .select('after_position')
              .eq('user_id', ctx.userId)
              .eq('topic_id', topicId)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()) as unknown as {
              data: { after_position: number } | null;
              error: { code?: string; message: string } | null;
            };
            if (shiftErr) {
              console.warn(
                JSON.stringify({
                  event: 'feed.list.stance_lookup_failed',
                  code: shiftErr.code ?? 'unknown',
                }),
              );
              return;
            }
            if (!shift) return;
            latestStance[topicId] =
              shift.after_position > 0 ? 'agree' : shift.after_position < 0 ? 'disagree' : null;
          }),
        );
      }

      const topics = topicRows.map((row) => ({
        id: row.id,
        headline: row.headline,
        sourceTitle: row.source_title,
        summary: row.summary,
        primarySourceUrl: row.primary_source_url,
        category: row.category,
        dropAt: row.drop_at,
        dedupClusterId: row.dedup_cluster_id,
        curationMode: row.curation_mode,
        isBlockExhausted: row.is_block_exhausted,
        additionalSources: Array.isArray(row.additional_sources) ? row.additional_sources : [],
        userStance: latestStance[row.id] ?? null,
        factExplainer: parseFactExplainer(row.fact_explainer),
      }));

      return { topics };
    }),

  // Post-vote split surface. The RPC `topic_stance_split` applies
  // the privacy floor in SQL: when fewer than 5 users have a non-
  // skip stance it returns {null, null, null, early: true} so even
  // a direct `POST /rest/v1/rpc/topic_stance_split` by any
  // authenticated JWT cannot read small-N counts. At >= 5 it
  // returns real counts + early: false. This handler trusts the
  // `early` flag and ALSO re-checks agree + total against the <5
  // floor as belt-and-braces (if a future RPC rewrite drops the
  // SQL-side guard, this handler still refuses to publish small-N
  // percentages).
  //
  // Why floor at 5: with n=1..4 and a public split, an attacker who
  // votes and refetches can infer any other user's stance by
  // differencing their own. Five is the smallest band where single-
  // user attribution needs active collusion rather than one tap.
  //
  // Rate limit mirrors feed.list — 60/min covers the "refetch after
  // each stance tap" pattern comfortably and matches the sibling
  // query's throughput. No mutation here; no need for the stricter
  // mutation band.
  getSplit: protectedProcedure
    .use(queryLimit('feed.getSplit', { perMin: 60 }))
    .input(z.object({ topicId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Cast the rpc callsite for symmetry with the rest of the file;
      // the hand-added Functions entry in packages/db/src/types.ts
      // (`topic_stance_split`) covers the type side, but keeping the
      // cast tolerates a stale types.ts regen on a CI node that
      // hasn't pulled the latest generator output yet. The runtime
      // shape is enforced by `toNum` + the `early` discriminator
      // below.
      const rpc = ctx.db.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: unknown;
        error: { code?: string; message: string } | null;
      }>;
      const { data, error } = (await rpc('topic_stance_split', {
        p_topic_id: input.topicId,
      })) as unknown as {
        data:
          | {
              agree_count: number | string | null;
              disagree_count: number | string | null;
              total: number | string | null;
              early: boolean | null;
            }
          | Array<{
              agree_count: number | string | null;
              disagree_count: number | string | null;
              total: number | string | null;
              early: boolean | null;
            }>
          | null;
        error: { code?: string; message: string } | null;
      };

      if (error) {
        // Log the PG error code (short, enum-like); omit the message
        // so a raised-exception string or query-shape text can never
        // leak through the tRPC wire response.
        console.warn(
          JSON.stringify({
            event: 'feed.getSplit.rpc_failed',
            code: error.code ?? 'unknown',
          }),
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load split.',
          cause: new Error(error.code ?? 'db_error'),
        });
      }

      // The RPC returns a SETOF row (always one row; PostgREST
      // sometimes wraps SETOF results in an array). Normalise.
      const row = Array.isArray(data) ? data[0] : data;
      const toNum = (v: number | string | undefined | null): number => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        }
        return 0;
      };
      const agree = toNum(row?.agree_count);
      const total = toNum(row?.total);
      const earlyFromSql = row?.early === true;

      // Trust the SQL-side `early` flag, AND re-apply the <5 check on
      // whatever `total` came back as. In early mode SQL returns
      // total = null which `toNum` normalises to 0 — so the belt-and-
      // braces condition also trips, as it should.
      if (earlyFromSql || total < 5) {
        return { early: true as const };
      }

      // Whole-integer percentages that sum to 100. Floor agree, give
      // the remainder to disagree so the two bars always tile the
      // bar width exactly. (Alternative: round-half-up on both and
      // accept a 1pp drift — we prefer exact tiling over symmetric
      // rounding, since the bar renders directly from these numbers.)
      const agreePct = Math.floor((agree / total) * 100);
      const disagreePct = 100 - agreePct;

      return {
        agreePct,
        disagreePct,
        total,
        early: false as const,
      };
    }),
});
