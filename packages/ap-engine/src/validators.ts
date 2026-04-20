/**
 * Zod schemas for AP-engine inputs + ledger writes.
 *
 * The `reason` enum mirrors the `ap_transactions.reason` CHECK constraint
 * in `supabase/migrations/20260420090002_identity_and_economy.sql`. Keep
 * these in lockstep — the DB will reject any insert whose `reason` is not
 * in the allowed set.
 */

import {
  ApReasonSchema,
  BattleIdSchema,
  BattleModeSchema,
  TierSchema,
  UserIdSchema,
} from '@diktat/shared';
import { z } from 'zod';

/** ELO delta input. Used by `computeApDelta` callers that want validation. */
export const ApDeltaInputSchema = z.object({
  winnerAp: z.number().int().nonnegative(),
  loserAp: z.number().int().nonnegative(),
  winnerTier: TierSchema,
  loserTier: TierSchema,
  mode: BattleModeSchema,
});
export type ApDeltaInput = z.infer<typeof ApDeltaInputSchema>;

/**
 * Input for `settleBattle`. Carries everything the orchestrator needs to
 * derive the deterministic ledger drafts: who fought, who won, the tier
 * + AP snapshots at settle time, and the loser's streak counters.
 *
 * `status` is included so a void/cancelled battle short-circuits to an
 * empty draft list without needing a separate code path.
 */
export const BattleSettleInputSchema = z.object({
  battleId: BattleIdSchema,
  mode: BattleModeSchema,
  status: z.enum(['settled', 'void']),
  winner: z.object({
    userId: UserIdSchema,
    apBefore: z.number().int().nonnegative(),
    tier: TierSchema,
  }),
  loser: z.object({
    userId: UserIdSchema,
    apBefore: z.number().int().nonnegative(),
    tier: TierSchema,
    consecutiveLosses: z.number().int().nonnegative(),
    reductionsUsed: z.number().int().nonnegative(),
  }),
});
export type BattleSettleInput = z.infer<typeof BattleSettleInputSchema>;

/**
 * One ledger draft = one row that will land in `ap_transactions`. The shape
 * mirrors the table (without `id` + `created_at`, both DB-defaulted, and
 * with the engine's `idempotencyKey` as the unique guard).
 */
export const ApTransactionWriteSchema = z.object({
  userId: UserIdSchema,
  delta: z.number().int(),
  /** Computed by the adapter from a fresh `users.current_ap` read at write time. */
  balanceAfter: z.number().int().nonnegative(),
  reason: ApReasonSchema,
  refType: z.string().min(1).nullable(),
  refId: z.string().uuid().nullable(),
  idempotencyKey: z.string().min(1),
});
export type ApTransactionWrite = z.infer<typeof ApTransactionWriteSchema>;
