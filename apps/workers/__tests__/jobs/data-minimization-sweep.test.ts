import { describe, expect, it } from 'vitest';

import { dataMinimizationSweepHandler } from '../../src/jobs/data-minimization-sweep.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

function row(partial: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: partial.id ?? 'sweep-1',
    job_type: partial.job_type ?? 'data_minimization_sweep',
    idempotency_key: partial.idempotency_key ?? '2026-10-22',
    target_user_id: null,
    payload: partial.payload ?? { dry_run: true },
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

const RESULT_SHAPE = {
  dry_run: true,
  blocked_candidates: 2,
  pre_launch_candidates: 0,
  deleted_blocked: 0,
  deleted_pre_launch: 0,
  blocked_candidate_ids: [] as string[],
  pre_launch_candidate_ids: [] as string[],
  launch_date: '2026-10-21',
  swept_at: '2026-10-22T03:00:00Z',
};

describe('dataMinimizationSweepHandler', () => {
  it('passes dry_run=true from payload to the RPC and logs the counts', async () => {
    const rpc: FakeRpc = { calls: [], next: { data: RESULT_SHAPE, error: null } };
    const logger = buildLogger();
    await dataMinimizationSweepHandler(row(), { supabase: buildSupabase(rpc), logger });

    expect(rpc.calls).toEqual([{ fn: 'data_minimization_sweep', args: { p_dry_run: true } }]);
    const log = logger.calls.find((c) => c.obj.event === 'data_minimization.sweep');
    expect(log?.obj).toMatchObject({
      dryRun: true,
      blockedCandidates: 2,
      preLaunchCandidates: 0,
      deletedBlocked: 0,
      deletedPreLaunch: 0,
      launchDate: '2026-10-21',
    });
  });

  it('defaults dry_run to true when payload omits the flag (fail-safe)', async () => {
    // The handler NEVER infers a live run from an unset payload.
    const rpc: FakeRpc = { calls: [], next: { data: RESULT_SHAPE, error: null } };
    await dataMinimizationSweepHandler(row({ payload: {} }), {
      supabase: buildSupabase(rpc),
      logger: buildLogger(),
    });
    expect(rpc.calls[0]?.args).toEqual({ p_dry_run: true });
  });

  it('passes dry_run=false ONLY when payload explicitly says so', async () => {
    const rpc: FakeRpc = {
      calls: [],
      next: {
        data: { ...RESULT_SHAPE, dry_run: false, deleted_blocked: 2 },
        error: null,
      },
    };
    await dataMinimizationSweepHandler(row({ payload: { dry_run: false } }), {
      supabase: buildSupabase(rpc),
      logger: buildLogger(),
    });
    expect(rpc.calls[0]?.args).toEqual({ p_dry_run: false });
  });

  it('rejects truthy non-boolean payload.dry_run values as dry-run (strict boolean compare)', async () => {
    // A crafted payload with `dry_run: "false"` (string) must NOT be
    // treated as live. Only the exact boolean literal `false` flips.
    const rpc: FakeRpc = { calls: [], next: { data: RESULT_SHAPE, error: null } };
    await dataMinimizationSweepHandler(
      row({ payload: { dry_run: 'false' as unknown as boolean } }),
      { supabase: buildSupabase(rpc), logger: buildLogger() },
    );
    expect(rpc.calls[0]?.args).toEqual({ p_dry_run: true });
  });

  it('throws on RPC error so the scheduler retries', async () => {
    const rpc: FakeRpc = {
      calls: [],
      next: { data: null, error: { message: 'boom' } },
    };
    await expect(
      dataMinimizationSweepHandler(row(), { supabase: buildSupabase(rpc), logger: buildLogger() }),
    ).rejects.toThrow(/data_minimization_sweep RPC failed/);
  });

  it('throws on null RPC result (unexpected)', async () => {
    const rpc: FakeRpc = { calls: [], next: { data: null, error: null } };
    await expect(
      dataMinimizationSweepHandler(row(), { supabase: buildSupabase(rpc), logger: buildLogger() }),
    ).rejects.toThrow(/returned null result/);
  });

  it('logs candidate UUID arrays and their lengths (migration 20261114000000)', async () => {
    const blocked = [
      '11111111-aaaa-4111-8111-111111111111',
      '22222222-bbbb-4222-8222-222222222222',
    ];
    const preLaunch = ['44444444-dddd-4444-8444-444444444444'];
    const rpc: FakeRpc = {
      calls: [],
      next: {
        data: {
          ...RESULT_SHAPE,
          blocked_candidates: blocked.length,
          pre_launch_candidates: preLaunch.length,
          blocked_candidate_ids: blocked,
          pre_launch_candidate_ids: preLaunch,
        },
        error: null,
      },
    };
    const logger = buildLogger();
    await dataMinimizationSweepHandler(row(), { supabase: buildSupabase(rpc), logger });
    const log = logger.calls.find((c) => c.obj.event === 'data_minimization.sweep');
    expect(log?.obj).toMatchObject({
      blockedCandidateIds: blocked,
      blockedCandidateIdsLength: 2,
      preLaunchCandidateIds: preLaunch,
      preLaunchCandidateIdsLength: 1,
    });
  });

  it('defaults missing candidate arrays to [] (legacy RPC compatibility)', async () => {
    // Guards against a stale deployment order where the handler ships
    // before the migration lands — the handler must not crash reading
    // an undefined array.
    const rpc: FakeRpc = {
      calls: [],
      next: {
        data: {
          dry_run: true,
          blocked_candidates: 0,
          pre_launch_candidates: 0,
          deleted_blocked: 0,
          deleted_pre_launch: 0,
          launch_date: '2026-10-21',
          swept_at: '2026-10-22T03:00:00Z',
        },
        error: null,
      },
    };
    const logger = buildLogger();
    await dataMinimizationSweepHandler(row(), { supabase: buildSupabase(rpc), logger });
    const log = logger.calls.find((c) => c.obj.event === 'data_minimization.sweep');
    expect(log?.obj).toMatchObject({
      blockedCandidateIds: [],
      blockedCandidateIdsLength: 0,
      preLaunchCandidateIds: [],
      preLaunchCandidateIdsLength: 0,
    });
  });
});
