import { describe, expect, it, vi } from 'vitest';

import {
  handlePrivyProvision,
  type HandlerDeps,
  type PrivyWalletProvider,
} from '../../src/jobs/privy-provision.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

interface SelectedRow {
  user_id: string;
  privy_user_id: string | null;
}

function buildLogger(): Logger & { calls: { event: string; obj: object }[] } {
  const calls: { event: string; obj: object }[] = [];
  const push = (event: string) => (obj: object) => {
    calls.push({ event, obj });
  };
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

interface FakeSupabase {
  client: ServiceClient;
  selectResult: { data: SelectedRow | null; error: { message: string } | null };
  updateResult: { error: { message: string } | null };
  selectCalls: number;
  updateCalls: { payload: Record<string, unknown>; userId: string }[];
}

function buildSupabase(initial: {
  selectResult?: FakeSupabase['selectResult'];
  updateResult?: FakeSupabase['updateResult'];
}): FakeSupabase {
  const state: FakeSupabase = {
    client: null as unknown as ServiceClient,
    selectResult: initial.selectResult ?? { data: null, error: null },
    updateResult: initial.updateResult ?? { error: null },
    selectCalls: 0,
    updateCalls: [],
  };

  const fromImpl = (table: string) => {
    if (table !== 'wallets') {
      throw new Error(`fakeSupabase: unexpected table ${table}`);
    }
    let pendingUpdate: Record<string, unknown> | null = null;

    const builder = {
      select(_cols: string) {
        return {
          eq(_col: string, _val: string) {
            return {
              maybeSingle: async () => {
                state.selectCalls += 1;
                return state.selectResult;
              },
            };
          },
        };
      },
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        return {
          eq: async (_col: string, val: string) => {
            state.updateCalls.push({
              payload: pendingUpdate as Record<string, unknown>,
              userId: val,
            });
            return state.updateResult;
          },
        };
      },
    };
    return builder;
  };

  state.client = { from: fromImpl } as unknown as ServiceClient;
  return state;
}

function buildPrivy(
  impl: (opts: { ownerExternalId: string }) => Promise<{
    privyUserId: string;
    solanaAddress: string;
    evmAddress: string | null;
  }>,
): PrivyWalletProvider & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async createSolanaWallet(opts) {
      calls += 1;
      return impl(opts);
    },
  };
}

const USER_ID = '00000000-0000-0000-0000-000000000aaa';

describe('handlePrivyProvision', () => {
  it('skips with reason flag_disabled when privy provider is null', async () => {
    const logger = buildLogger();
    const supabase = buildSupabase({});
    const deps: HandlerDeps = {
      supabase: supabase.client,
      privy: null,
      logger,
    };

    const result = await handlePrivyProvision(USER_ID, deps);

    expect(result).toEqual({ status: 'skipped', reason: 'flag_disabled' });
    expect(supabase.selectCalls).toBe(0);
    expect(supabase.updateCalls).toEqual([]);
    expect(
      logger.calls.find(
        (c) =>
          c.event === 'info' &&
          (c.obj as { event: string }).event === 'privy.skipped' &&
          (c.obj as { reason: string }).reason === 'flag_disabled',
      ),
    ).toBeDefined();
  });

  it('provisions a fresh wallet end to end', async () => {
    const logger = buildLogger();
    const supabase = buildSupabase({
      selectResult: { data: { user_id: USER_ID, privy_user_id: null }, error: null },
      updateResult: { error: null },
    });
    const privy = buildPrivy(async ({ ownerExternalId }) => ({
      privyUserId: `privy_${ownerExternalId.slice(0, 8)}`,
      solanaAddress: 'SoL11111111111111111111111111111',
      evmAddress: null,
    }));

    const result = await handlePrivyProvision(USER_ID, {
      supabase: supabase.client,
      privy,
      logger,
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'provisioned' });
    expect(privy.calls).toBe(1);
    expect(supabase.updateCalls).toHaveLength(1);
    const updated = supabase.updateCalls[0]!;
    expect(updated.userId).toBe(USER_ID);
    expect(updated.payload).toMatchObject({
      privy_user_id: `privy_${USER_ID.slice(0, 8)}`,
      solana_address: 'SoL11111111111111111111111111111',
      external_wallet_id: 'SoL11111111111111111111111111111',
    });
  });

  it('skips when wallet is already provisioned (idempotent)', async () => {
    const logger = buildLogger();
    const supabase = buildSupabase({
      selectResult: {
        data: { user_id: USER_ID, privy_user_id: 'privy_already_set' },
        error: null,
      },
    });
    const privy = buildPrivy(async () => {
      throw new Error('Privy must not be called when already provisioned');
    });

    const result = await handlePrivyProvision(USER_ID, {
      supabase: supabase.client,
      privy,
      logger,
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'skipped', reason: 'already_provisioned' });
    expect(privy.calls).toBe(0);
    expect(supabase.updateCalls).toEqual([]);
  });

  it('returns failed/retries_exhausted without throwing when Privy keeps failing', async () => {
    const logger = buildLogger();
    const supabase = buildSupabase({
      selectResult: { data: { user_id: USER_ID, privy_user_id: null }, error: null },
    });
    const privy = buildPrivy(async () => {
      throw new Error('boom');
    });
    const sleep = vi.fn(async (_ms: number) => {});

    const result = await handlePrivyProvision(USER_ID, {
      supabase: supabase.client,
      privy,
      logger,
      sleep,
    });

    expect(result).toEqual({ status: 'failed', reason: 'retries_exhausted' });
    expect(privy.calls).toBe(5);
    expect(supabase.updateCalls).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(4); // sleep between attempts, not after the last
    expect(
      logger.calls.find(
        (c) => c.event === 'error' && (c.obj as { event: string }).event === 'privy.failed',
      ),
    ).toBeDefined();
  });

  it('reports skipped/wallet_missing when no shell row exists', async () => {
    const logger = buildLogger();
    const supabase = buildSupabase({ selectResult: { data: null, error: null } });
    const privy = buildPrivy(async () => {
      throw new Error('Privy must not be called without a wallet row');
    });

    const result = await handlePrivyProvision(USER_ID, {
      supabase: supabase.client,
      privy,
      logger,
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'skipped', reason: 'wallet_missing' });
    expect(privy.calls).toBe(0);
  });
});
