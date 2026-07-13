/**
 * Thin Supabase adapter for the AP engine.
 *
 * RESPONSIBILITY BOUNDARY
 * This is the only file in `@diktat/ap-engine` that may import Supabase.
 * Everything upstream of `applyDrafts` is pure, deterministic, and
 * testable without a database.
 *
 * Phase 3 onward: this adapter calls the `apply_ap_drafts(jsonb)` SQL
 * function (migration 0013) which atomically:
 *   1. Looks up each draft's idempotency_key — duplicates short-circuit.
 *   2. Locks `users.id FOR UPDATE` so concurrent settles for the same
 *      user serialize.
 *   3. Enforces the practice 200/day cap on positive practice deltas.
 *   4. Inserts `ap_transactions`, updates `users.current_ap`, and (for
 *      ghost mints) bumps `wallets.usdc_balance_micro` — all in one
 *      transaction.
 *
 * The function is `SECURITY DEFINER` and granted to `service_role` only;
 * callers MUST hold a service-role client.
 *
 * TYPE BOUNDARY
 * The client is typed as `SupabaseClient<unknown>` because `@diktat/db`
 * may not yet emit the `apply_ap_drafts` function in `Database['public']
 * ['Functions']`. Once regenerated, callers can pass `SupabaseClient<
 * Database>` and the cast inside this file becomes a no-op.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApTransactionDraft } from './settle.js';

export interface ApplyResult {
  readonly idempotencyKey: string;
  readonly applied: boolean;
  /** Live `users.current_ap` after the apply. Null when the user row was missing. */
  readonly balanceAfter: number | null;
  /** Delta actually credited — may differ from draft.delta when the practice cap kicks in. */
  readonly cappedDelta: number;
  readonly skippedReason?: 'duplicate' | 'user_not_found';
  /**
   * Tier crossing for this apply, recomputed inside `apply_ap_drafts` from the
   * before/after balance. CONTRACT: on a duplicate or user_not_found result,
   * `tierBefore` and `tierAfter` are null and `tierChanged` is false — a replay
   * signals NO crossing, so a celebration consumer must gate on `tierChanged`
   * and never fall back to `tierAfter` when it is null.
   */
  readonly tierBefore: number | null;
  readonly tierAfter: number | null;
  readonly tierChanged: boolean;
}

interface RpcDraftPayload {
  user_id: string;
  delta: number;
  ghost_usd_micros: string;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  idempotency_key: string;
  is_practice: boolean;
}

interface RpcResultRow {
  idempotency_key: string;
  applied: boolean;
  balance_after: number | null;
  capped_delta: number;
  skipped_reason: 'duplicate' | 'user_not_found' | null;
  tier_before: number | null;
  tier_after: number | null;
  tier_changed: boolean;
}

function toRpcPayload(draft: ApTransactionDraft): RpcDraftPayload {
  return {
    user_id: draft.userId as string,
    delta: draft.delta,
    // jsonb numbers in PostgREST round-trip safely as strings for bigints.
    ghost_usd_micros: draft.ghostUsdMicros.toString(),
    reason: draft.reason,
    ref_type: draft.refType,
    ref_id: draft.refId as string | null,
    idempotency_key: draft.idempotencyKey,
    is_practice: draft.isPractice,
  };
}

/**
 * Apply a batch of drafts via the `apply_ap_drafts(jsonb)` SQL function.
 * Idempotent: re-running with the same drafts produces
 * `applied=false / skippedReason='duplicate'` for already-recorded
 * idempotency keys.
 *
 * Throws on transport / function-level errors. Per-draft failures
 * (e.g. user_not_found) come back as `applied=false` with a
 * `skippedReason` — the function never aborts the batch on a per-draft
 * issue.
 */
export async function applyDrafts(
  client: SupabaseClient<unknown>,
  drafts: ApTransactionDraft[],
): Promise<ApplyResult[]> {
  if (drafts.length === 0) return [];

  const payload = drafts.map(toRpcPayload);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcResult = (await (client as any).rpc('apply_ap_drafts', { p_drafts: payload })) as {
    data: RpcResultRow[] | null;
    error: { message: string } | null;
  };

  if (rpcResult.error) {
    throw new Error(`applyDrafts: apply_ap_drafts failed: ${rpcResult.error.message}`);
  }

  const rows = rpcResult.data ?? [];
  const byKey = new Map<string, RpcResultRow>();
  for (const row of rows) byKey.set(row.idempotency_key, row);

  return drafts.map((draft): ApplyResult => {
    const row = byKey.get(draft.idempotencyKey);
    if (!row) {
      // Defensive — should never happen if the function is well-behaved.
      return {
        idempotencyKey: draft.idempotencyKey,
        applied: false,
        balanceAfter: null,
        cappedDelta: 0,
        skippedReason: 'user_not_found',
        tierBefore: null,
        tierAfter: null,
        tierChanged: false,
      };
    }
    // The three tier fields go on `base` so they survive BOTH the plain return
    // and the `{ ...base, skippedReason }` spread below.
    const base: ApplyResult = {
      idempotencyKey: row.idempotency_key,
      applied: row.applied,
      balanceAfter: row.balance_after,
      cappedDelta: row.capped_delta,
      tierBefore: row.tier_before,
      tierAfter: row.tier_after,
      tierChanged: row.tier_changed,
    };
    return row.skipped_reason ? { ...base, skippedReason: row.skipped_reason } : base;
  });
}
