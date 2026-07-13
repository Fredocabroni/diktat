import { battleId, userId } from '@diktat/shared';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { applyDrafts } from '../src/db.js';
import type { ApTransactionDraft } from '../src/settle.js';

const BID = battleId('11111111-1111-4111-8111-111111111111');
const WINNER = userId('22222222-2222-4222-8222-222222222222');
const LOSER = userId('33333333-3333-4333-8333-333333333333');

function buildDrafts(opts: { isPractice?: boolean } = {}): ApTransactionDraft[] {
  const isPractice = opts.isPractice ?? false;
  return [
    {
      userId: WINNER,
      delta: 30,
      ghostUsdMicros: 0n,
      reason: 'battle_win',
      refType: 'battle',
      refId: BID,
      idempotencyKey: `battle:${BID}:user:${WINNER}:reason:battle_win`,
      isPractice,
    },
    {
      userId: LOSER,
      delta: -30,
      ghostUsdMicros: 0n,
      reason: 'battle_loss',
      refType: 'battle',
      refId: BID,
      idempotencyKey: `battle:${BID}:user:${LOSER}:reason:battle_loss`,
      isPractice,
    },
  ];
}

interface FakeRpcCall {
  fn: string;
  args: unknown;
}

function buildClient(
  opts: {
    data?: unknown;
    error?: { message: string } | null;
  } = {},
): { client: SupabaseClient<unknown>; calls: FakeRpcCall[] } {
  const calls: FakeRpcCall[] = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return { data: opts.data ?? [], error: opts.error ?? null };
    }),
  } as unknown as SupabaseClient<unknown>;
  return { client, calls };
}

describe('applyDrafts (RPC adapter)', () => {
  it('returns an empty array for an empty drafts list and skips the RPC entirely', async () => {
    const { client, calls } = buildClient();
    const result = await applyDrafts(client, []);
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('round-trips a successful apply', async () => {
    const drafts = buildDrafts();
    const { client, calls } = buildClient({
      data: [
        {
          idempotency_key: drafts[0]!.idempotencyKey,
          applied: true,
          balance_after: 2030,
          capped_delta: 30,
          skipped_reason: null,
          tier_before: 4,
          tier_after: 4,
          tier_changed: false,
        },
        {
          idempotency_key: drafts[1]!.idempotencyKey,
          applied: true,
          balance_after: 1970,
          capped_delta: -30,
          skipped_reason: null,
          tier_before: 4,
          tier_after: 4,
          tier_changed: false,
        },
      ],
    });

    const result = await applyDrafts(client, drafts);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('apply_ap_drafts');
    const sentArgs = calls[0]!.args as { p_drafts: Array<Record<string, unknown>> };
    expect(sentArgs.p_drafts).toHaveLength(2);
    expect(sentArgs.p_drafts[0]!).toMatchObject({
      user_id: WINNER,
      delta: 30,
      reason: 'battle_win',
      is_practice: false,
      ghost_usd_micros: '0',
    });

    expect(result).toHaveLength(2);
    expect(result[0]!).toEqual({
      idempotencyKey: drafts[0]!.idempotencyKey,
      applied: true,
      balanceAfter: 2030,
      cappedDelta: 30,
      tierBefore: 4,
      tierAfter: 4,
      tierChanged: false,
    });
    expect(result[1]!.applied).toBe(true);
  });

  it('surfaces the SQL function row order regardless of input order', async () => {
    const drafts = buildDrafts();
    const { client } = buildClient({
      // Reverse the order from the function.
      data: [
        {
          idempotency_key: drafts[1]!.idempotencyKey,
          applied: true,
          balance_after: 1970,
          capped_delta: -30,
          skipped_reason: null,
        },
        {
          idempotency_key: drafts[0]!.idempotencyKey,
          applied: false,
          balance_after: 2000,
          capped_delta: 0,
          skipped_reason: 'duplicate',
        },
      ],
    });

    const result = await applyDrafts(client, drafts);

    // The adapter re-orders to match the input order.
    expect(result[0]!.idempotencyKey).toBe(drafts[0]!.idempotencyKey);
    expect(result[0]!.applied).toBe(false);
    expect(result[0]!.skippedReason).toBe('duplicate');
    expect(result[1]!.idempotencyKey).toBe(drafts[1]!.idempotencyKey);
    expect(result[1]!.applied).toBe(true);
  });

  it('reports user_not_found when the SQL function omits a row entirely', async () => {
    const drafts = buildDrafts();
    const { client } = buildClient({
      data: [
        {
          idempotency_key: drafts[0]!.idempotencyKey,
          applied: true,
          balance_after: 2030,
          capped_delta: 30,
          skipped_reason: null,
        },
      ],
    });

    const result = await applyDrafts(client, drafts);

    expect(result[1]!).toEqual({
      idempotencyKey: drafts[1]!.idempotencyKey,
      applied: false,
      balanceAfter: null,
      cappedDelta: 0,
      skippedReason: 'user_not_found',
      tierBefore: null,
      tierAfter: null,
      tierChanged: false,
    });
  });

  it('forwards is_practice on every draft', async () => {
    const drafts = buildDrafts({ isPractice: true });
    const { client, calls } = buildClient({
      data: drafts.map((d) => ({
        idempotency_key: d.idempotencyKey,
        applied: true,
        balance_after: 1500,
        capped_delta: d.delta,
        skipped_reason: null,
      })),
    });

    await applyDrafts(client, drafts);

    const sent = (calls[0]!.args as { p_drafts: Array<{ is_practice: boolean }> }).p_drafts;
    expect(sent.every((p) => p.is_practice === true)).toBe(true);
  });

  it('throws when the RPC returns an error', async () => {
    const drafts = buildDrafts();
    const { client } = buildClient({ error: { message: 'pg down' } });

    await expect(applyDrafts(client, drafts)).rejects.toThrow(/apply_ap_drafts failed: pg down/);
  });

  it('maps the tier crossing fields from an applied row', async () => {
    const drafts = buildDrafts();
    const { client } = buildClient({
      data: [
        {
          idempotency_key: drafts[0]!.idempotencyKey,
          applied: true,
          balance_after: 750,
          capped_delta: 1,
          skipped_reason: null,
          // 749 -> 750 crosses Partisan(2) -> Operative(3).
          tier_before: 2,
          tier_after: 3,
          tier_changed: true,
        },
        {
          idempotency_key: drafts[1]!.idempotencyKey,
          applied: true,
          balance_after: 1970,
          capped_delta: -30,
          skipped_reason: null,
          tier_before: 4,
          tier_after: 4,
          tier_changed: false,
        },
      ],
    });

    const result = await applyDrafts(client, drafts);

    expect(result[0]!.tierBefore).toBe(2);
    expect(result[0]!.tierAfter).toBe(3);
    expect(result[0]!.tierChanged).toBe(true);
    expect(result[1]!.tierChanged).toBe(false);
  });

  it('maps a duplicate row to no crossing (tierChanged=false, tiers null)', async () => {
    const drafts = buildDrafts();
    const { client } = buildClient({
      data: [
        {
          idempotency_key: drafts[0]!.idempotencyKey,
          applied: false,
          balance_after: 750,
          capped_delta: 0,
          skipped_reason: 'duplicate',
          // Contract: a replay signals no crossing.
          tier_before: null,
          tier_after: null,
          tier_changed: false,
        },
        {
          idempotency_key: drafts[1]!.idempotencyKey,
          applied: false,
          balance_after: 1970,
          capped_delta: 0,
          skipped_reason: 'duplicate',
          tier_before: null,
          tier_after: null,
          tier_changed: false,
        },
      ],
    });

    const result = await applyDrafts(client, drafts);

    expect(result[0]!.skippedReason).toBe('duplicate');
    expect(result[0]!.tierChanged).toBe(false);
    expect(result[0]!.tierBefore).toBeNull();
    expect(result[0]!.tierAfter).toBeNull();
  });
});
