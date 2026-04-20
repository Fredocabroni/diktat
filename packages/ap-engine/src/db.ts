/**
 * Thin Supabase adapter for the AP engine.
 *
 * RESPONSIBILITY BOUNDARY
 * This is the only file in `@diktat/ap-engine` that may import Supabase.
 * Everything upstream of `applyDrafts` is pure, deterministic, and testable
 * without a database. The adapter does the minimum bookkeeping:
 *
 *   1. Read fresh `users.current_ap` for every distinct user in the drafts
 *      (one batched select).
 *   2. Compute `balance_after = current_ap + draft.delta`, floored at 0
 *      (the DB also enforces `current_ap >= 0` via CHECK; we floor here so
 *      the engine never proposes a write the DB will reject).
 *   3. Insert all rows in a single `ap_transactions` upsert with
 *      `ignoreDuplicates: true` on the `idempotency_key` unique constraint.
 *   4. For each draft, return whether it was newly applied or skipped as
 *      a duplicate (so the caller can short-circuit downstream side effects).
 *
 * ATOMICITY CAVEAT — TODO(phase-2)
 * Supabase JS does not expose multi-statement transactions client-side.
 * This adapter is therefore best-effort:
 *   - The select-then-insert window is non-atomic. A concurrent settle
 *     touching the same user could read a stale `current_ap`.
 *   - The `ap_transactions` insert is atomic per row (PostgREST batch),
 *     and the unique `idempotency_key` blocks duplicates, but
 *     `users.current_ap` is NOT updated here.
 *   - In Phase 2 we will move this whole flow into a Postgres function
 *     `apply_ap_drafts(jsonb) returns jsonb` that does the read, write,
 *     balance update, and wallet ghost mint inside a single transaction.
 *     Until then, callers MUST update `users.current_ap` and `wallets`
 *     in their own code path (or accept eventual consistency).
 *
 * TYPE BOUNDARY
 * The client is typed as `SupabaseClient<unknown>` because `@diktat/db`
 * does not yet emit generated `Database` types. Once that lands, widen
 * the parameter to `SupabaseClient<Database>` and drop the local
 * `ApTransactionRow` shim. The shim mirrors the table column-for-column.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApTransactionDraft } from './settle.js';

// Local minimal row shape for `ap_transactions` insert. Mirrors:
//   supabase/migrations/20260420090002_identity_and_economy.sql
// Drop this once `@diktat/db` regenerates `Database['public']['Tables']`.
interface ApTransactionRow {
  user_id: string;
  delta: number;
  balance_after: number;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  idempotency_key: string;
}

export interface ApplyResult {
  readonly idempotencyKey: string;
  readonly applied: boolean;
  readonly skippedReason?: 'duplicate';
}

/**
 * Insert a batch of drafts into `ap_transactions`. Idempotent: re-running
 * with the same drafts produces the same `applied:false / skippedReason:'duplicate'`
 * outcome instead of double-spending AP.
 *
 * Throws on Supabase errors; returns one `ApplyResult` per input draft, in
 * the same order, on success.
 */
export async function applyDrafts(
  client: SupabaseClient<unknown>,
  drafts: ApTransactionDraft[],
): Promise<ApplyResult[]> {
  if (drafts.length === 0) return [];

  // 1) Fetch live balances for every distinct user touched by these drafts.
  //    NOTE: this is the non-atomic window described in the file header.
  const userIds = Array.from(new Set(drafts.map((d) => d.userId as string)));
  // Cast through `unknown` because `SupabaseClient<unknown>.from()` returns a
  // PostgrestQueryBuilder<unknown, never, never, never> that does not narrow
  // table columns. The local `ApTransactionRow` / `users.current_ap` shape is
  // the contract we're enforcing — widen this once `@diktat/db` ships generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usersTable = (client as any).from('users');
  const { data: userRows, error: usersErr } = (await usersTable
    .select('id, current_ap')
    .in('id', userIds)) as {
    data: { id: string; current_ap: number }[] | null;
    error: { message: string } | null;
  };

  if (usersErr) {
    throw new Error(`applyDrafts: failed to read users.current_ap: ${usersErr.message}`);
  }

  const balanceByUser = new Map<string, number>();
  for (const row of userRows ?? []) balanceByUser.set(row.id, row.current_ap);

  // 2) Build insert payloads. Floor balance_after at 0 — the DB CHECK enforces
  //    this too, but we want to never propose an illegal row.
  const payload: ApTransactionRow[] = drafts.map((draft) => {
    const current = balanceByUser.get(draft.userId as string) ?? 0;
    const projected = current + draft.delta;
    const balanceAfter = projected < 0 ? 0 : projected;
    // Mutate the running map so two drafts for the same user (e.g. battle_win
    // + ghost_credit, where ghost is delta=0) compute against the running balance.
    balanceByUser.set(draft.userId as string, balanceAfter);
    return {
      user_id: draft.userId as string,
      delta: draft.delta,
      balance_after: balanceAfter,
      reason: draft.reason,
      ref_type: draft.refType,
      ref_id: draft.refId as string | null,
      idempotency_key: draft.idempotencyKey,
    };
  });

  // 3) Batched upsert with on-conflict-do-nothing on the unique idempotency key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apTxTable = (client as any).from('ap_transactions');
  const { data: insertedRows, error: insertErr } = (await apTxTable
    .upsert(payload, {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    })
    .select('idempotency_key')) as {
    data: { idempotency_key: string }[] | null;
    error: { message: string } | null;
  };

  if (insertErr) {
    throw new Error(`applyDrafts: failed to insert ap_transactions: ${insertErr.message}`);
  }

  const insertedKeys = new Set((insertedRows ?? []).map((r) => r.idempotency_key));

  return drafts.map((draft) => {
    const applied = insertedKeys.has(draft.idempotencyKey);
    return applied
      ? { idempotencyKey: draft.idempotencyKey, applied: true }
      : { idempotencyKey: draft.idempotencyKey, applied: false, skippedReason: 'duplicate' };
  });
}
