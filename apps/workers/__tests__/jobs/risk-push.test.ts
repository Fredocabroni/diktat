import { describe, expect, it } from 'vitest';

import { riskPushHandler } from '../../src/jobs/risk-push.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

function row(partial: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: partial.id ?? 'rp-1',
    job_type: partial.job_type ?? 'risk_push',
    idempotency_key: partial.idempotency_key ?? '2026-05-25',
    target_user_id:
      'target_user_id' in partial
        ? (partial.target_user_id ?? null)
        : '795d3031-bfe6-47e3-9a35-7e6440122522',
    payload: partial.payload ?? {
      local_date: '2026-05-25',
      user_tz: 'America/New_York',
    },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'workers-test',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

interface FakeState {
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  rpcNext: { data: unknown; error: { message: string } | null };
  updates: { id: string; patch: Record<string, unknown> }[];
  updateError: { message: string } | null;
}

function buildSupabase(state: FakeState): ServiceClient {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcNext);
    },
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          state.updates.push({ id: String(id), patch });
          return Promise.resolve({ error: state.updateError });
        },
      }),
    }),
  } as unknown as ServiceClient;
}

function buildLogger(): Logger & {
  calls: { level: string; obj: Record<string, unknown> }[];
} {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

describe('riskPushHandler', () => {
  it('would_push: evaluates, stamps decision into payload, logs', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: {
        data: {
          decision: 'would_push',
          current_length: 6,
          progress: 2,
          freezes: 0,
          freezes_max: 2,
        },
        error: null,
      },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();

    await riskPushHandler(row(), { supabase, logger });

    expect(state.rpcCalls[0]).toEqual({
      fn: 'evaluate_risk_push',
      args: {
        p_user_id: '795d3031-bfe6-47e3-9a35-7e6440122522',
        p_local_date: '2026-05-25',
      },
    });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.id).toBe('rp-1');
    const patch = state.updates[0]?.patch as { payload: Record<string, unknown> };
    expect(patch.payload.decision).toBe('would_push');
    expect(patch.payload.current_length).toBe(6);
    expect(patch.payload.progress).toBe(2);
    expect(patch.payload.freezes).toBe(0);
    // Existing payload keys preserved
    expect(patch.payload.local_date).toBe('2026-05-25');
    expect(patch.payload.user_tz).toBe('America/New_York');

    const log = logger.calls.find((c) => c.obj.event === 'streak.risk_push_evaluated');
    expect(log?.obj.decision).toBe('would_push');
    expect(log?.obj.currentLength).toBe(6);
  });

  it('skip_completed: stamps decision, no extra signals (Take 5 done)', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: { decision: 'skip_completed' }, error: null },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();

    await riskPushHandler(row(), { supabase, logger });

    const patch = state.updates[0]?.patch as { payload: Record<string, unknown> };
    expect(patch.payload.decision).toBe('skip_completed');
    // No second RPC, no push emit — handler only touches scheduled_jobs
    expect(state.rpcCalls).toHaveLength(1);
  });

  it('skip_no_streak: stamps decision, never nudges users without a streak', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: { decision: 'skip_no_streak' }, error: null },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();

    await riskPushHandler(row(), { supabase, logger });

    const patch = state.updates[0]?.patch as { payload: Record<string, unknown> };
    expect(patch.payload.decision).toBe('skip_no_streak');
    expect(state.rpcCalls).toHaveLength(1);
  });

  it('throws when target_user_id is missing', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: null, error: null },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(
      riskPushHandler(row({ target_user_id: null }), { supabase, logger }),
    ).rejects.toThrow(/target_user_id is required/);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('throws when payload.local_date is missing', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: null, error: null },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(riskPushHandler(row({ payload: {} }), { supabase, logger })).rejects.toThrow(
      /payload.local_date is required/,
    );
  });

  it('throws when the evaluate RPC errors (scheduler retries via backoff)', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: null, error: { message: 'sql: timeout' } },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(riskPushHandler(row(), { supabase, logger })).rejects.toThrow(
      /evaluate_risk_push RPC failed.*timeout/,
    );
  });

  it('throws when the payload update fails (decision must be durable)', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: { decision: 'would_push', current_length: 3 }, error: null },
      updates: [],
      updateError: { message: 'permission denied' },
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(riskPushHandler(row(), { supabase, logger })).rejects.toThrow(
      /failed to stamp decision.*permission denied/,
    );
  });

  it('never delivers a push from this handler (4.4 scope — delivery deferred)', async () => {
    // Verify the handler makes exactly two supabase calls: the RPC + the
    // payload UPDATE. Nothing else. No push-channel SDK call, no
    // notification table insert, no email send. Delivery is the future
    // web-push PR's job — this handler only records the decision.
    const state: FakeState = {
      rpcCalls: [],
      rpcNext: { data: { decision: 'would_push', current_length: 5 }, error: null },
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await riskPushHandler(row(), { supabase, logger });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]?.fn).toBe('evaluate_risk_push');
    expect(state.updates).toHaveLength(1);
  });
});
