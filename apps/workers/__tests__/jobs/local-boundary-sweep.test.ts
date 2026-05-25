import { describe, expect, it } from 'vitest';

import { localBoundarySweepHandler } from '../../src/jobs/local-boundary-sweep.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

function row(partial: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: partial.id ?? 'sweep-1',
    job_type: partial.job_type ?? 'local_boundary_sweep',
    idempotency_key: partial.idempotency_key ?? '2026-05-25',
    target_user_id:
      'target_user_id' in partial
        ? (partial.target_user_id ?? null)
        : '795d3031-bfe6-47e3-9a35-7e6440122522',
    payload: partial.payload ?? { yesterday: '2026-05-24', user_tz: 'America/New_York' },
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

interface FakeRpc {
  calls: { fn: string; args: Record<string, unknown> }[];
  next: { data: unknown; error: { message: string } | null };
}

function buildSupabase(rpc: FakeRpc): ServiceClient {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return Promise.resolve(rpc.next);
    },
  } as unknown as ServiceClient;
}

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
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

describe('localBoundarySweepHandler', () => {
  it('calls apply_local_boundary_sweep with target_user_id + yesterday and logs the outcome', async () => {
    const rpc: FakeRpc = {
      calls: [],
      next: {
        data: { outcome: 'advanced', new_length: 4, freezes: 1, milestone_granted: false },
        error: null,
      },
    };
    const supabase = buildSupabase(rpc);
    const logger = buildLogger();

    await localBoundarySweepHandler(row(), { supabase, logger });

    expect(rpc.calls).toEqual([
      {
        fn: 'apply_local_boundary_sweep',
        args: {
          p_user_id: '795d3031-bfe6-47e3-9a35-7e6440122522',
          p_yesterday: '2026-05-24',
        },
      },
    ]);
    const sweepLog = logger.calls.find((c) => c.obj.event === 'streak.boundary_sweep');
    expect(sweepLog?.level).toBe('info');
    expect(sweepLog?.obj.outcome).toBe('advanced');
    expect(sweepLog?.obj.newLength).toBe(4);
    expect(sweepLog?.obj.freezes).toBe(1);
  });

  it('logs each outcome variant correctly', async () => {
    for (const outcome of [
      'advanced',
      'frozen',
      'broken',
      'already_swept',
      'streak_not_found',
    ] as const) {
      const rpc: FakeRpc = {
        calls: [],
        next: { data: { outcome }, error: null },
      };
      const supabase = buildSupabase(rpc);
      const logger = buildLogger();
      await localBoundarySweepHandler(row(), { supabase, logger });
      const log = logger.calls.find((c) => c.obj.event === 'streak.boundary_sweep');
      expect(log?.obj.outcome, `outcome=${outcome}`).toBe(outcome);
    }
  });

  it('throws when target_user_id is missing (scheduler retries via backoff)', async () => {
    const supabase = buildSupabase({ calls: [], next: { data: null, error: null } });
    const logger = buildLogger();
    await expect(
      localBoundarySweepHandler(row({ target_user_id: null }), { supabase, logger }),
    ).rejects.toThrow(/target_user_id is required/);
  });

  it('throws when payload.yesterday is missing', async () => {
    const supabase = buildSupabase({ calls: [], next: { data: null, error: null } });
    const logger = buildLogger();
    await expect(
      localBoundarySweepHandler(row({ payload: {} }), { supabase, logger }),
    ).rejects.toThrow(/payload.yesterday is required/);
  });

  it('throws when the RPC errors (scheduler retries via backoff)', async () => {
    const supabase = buildSupabase({
      calls: [],
      next: { data: null, error: { message: 'sql: connection refused' } },
    });
    const logger = buildLogger();
    await expect(localBoundarySweepHandler(row(), { supabase, logger })).rejects.toThrow(
      /apply_local_boundary_sweep RPC failed.*connection refused/,
    );
  });

  it('emits no push or downstream signal on broken outcome (ADDICTION §11.5)', async () => {
    const rpc: FakeRpc = {
      calls: [],
      next: { data: { outcome: 'broken', new_length: 0 }, error: null },
    };
    const supabase = buildSupabase(rpc);
    const logger = buildLogger();
    await localBoundarySweepHandler(row(), { supabase, logger });

    // No additional RPCs (no push trigger, no notify call).
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]?.fn).toBe('apply_local_boundary_sweep');
    // No warn/error level logs — break is silent.
    const nonInfoLogs = logger.calls.filter((c) => c.level !== 'info');
    expect(nonInfoLogs).toHaveLength(0);
  });
});
