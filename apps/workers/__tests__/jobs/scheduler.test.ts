import { describe, expect, it, vi } from 'vitest';

import {
  __testing,
  defaultHandlers,
  heartbeatHandler,
  runSchedulerTick,
  type JobHandler,
  type ScheduledJobRow,
} from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function row(partial: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: partial.id ?? `job-${Math.random().toString(36).slice(2, 8)}`,
    job_type: partial.job_type ?? 'heartbeat',
    idempotency_key: partial.idempotency_key ?? '2026-05-22 20:15',
    target_user_id: partial.target_user_id ?? null,
    payload: partial.payload ?? {},
    status: partial.status ?? 'pending',
    attempts: partial.attempts ?? 1,
    max_attempts: partial.max_attempts ?? 5,
    available_at: partial.available_at ?? nowIso(-1000),
    locked_at: partial.locked_at ?? nowIso(),
    locked_by: partial.locked_by ?? 'workers-test',
    last_error: partial.last_error ?? null,
    processed_at: partial.processed_at ?? null,
    created_at: partial.created_at ?? nowIso(-5000),
    updated_at: partial.updated_at ?? nowIso(),
  };
}

interface FakeSupabase {
  client: ServiceClient;
  /** Rows the next claim returns. Tests prime this. */
  claimReturn: ScheduledJobRow[];
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  updates: { id: string; patch: Record<string, unknown> }[];
  reapResult: { id: string }[];
}

function buildSupabase(
  opts: { claimReturn?: ScheduledJobRow[]; reapResult?: { id: string }[] } = {},
): FakeSupabase {
  const state: FakeSupabase = {
    client: null as unknown as ServiceClient,
    claimReturn: opts.claimReturn ?? [],
    rpcCalls: [],
    updates: [],
    reapResult: opts.reapResult ?? [],
  };

  // Update-by-id chain: .from('scheduled_jobs').update(patch).eq('id', id) -> { error }
  // Reap chain: .from('scheduled_jobs').update(patch).eq('status','processing').lt('locked_at', cutoff).select('id') -> { data, error }
  const fromImpl = (table: string) => {
    if (table !== 'scheduled_jobs') throw new Error(`fake: unexpected table ${table}`);
    return {
      update(patch: Record<string, unknown>) {
        const eqByStatus = { status: undefined as string | undefined };
        return {
          eq(col: string, val: unknown) {
            if (col === 'id') {
              state.updates.push({ id: String(val), patch });
              return Promise.resolve({ error: null });
            }
            if (col === 'status') {
              eqByStatus.status = String(val);
              return {
                lt(_col2: string, _val2: unknown) {
                  return {
                    select(_cols: string) {
                      return Promise.resolve({ data: state.reapResult, error: null });
                    },
                  };
                },
              };
            }
            throw new Error(`fake: unexpected eq column ${col}`);
          },
        };
      },
    };
  };

  const rpcImpl = (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    if (fn !== 'claim_scheduled_jobs') throw new Error(`fake: unexpected rpc ${fn}`);
    return Promise.resolve({ data: state.claimReturn, error: null });
  };

  state.client = { from: fromImpl, rpc: rpcImpl } as unknown as ServiceClient;
  return state;
}

function buildLogger(): Logger & { calls: { level: string; obj: object }[] } {
  const calls: { level: string; obj: object }[] = [];
  const push = (level: string) => (obj: object) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

describe('runSchedulerTick', () => {
  it('claims a heartbeat row, dispatches the handler, and marks done', async () => {
    const r = row({ id: 'hb-1', job_type: 'heartbeat' });
    const supabase = buildSupabase({ claimReturn: [r] });
    const logger = buildLogger();

    const result = await runSchedulerTick({
      supabase: supabase.client,
      logger,
      workerId: 'w1',
      handlers: defaultHandlers,
    });

    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 1,
      retried: 0,
      deadLettered: 0,
      errors: 0,
    });
    expect(supabase.rpcCalls).toHaveLength(1);
    expect(supabase.rpcCalls[0]!).toMatchObject({
      fn: 'claim_scheduled_jobs',
      args: {
        p_handler_types: [
          'heartbeat',
          'local_boundary_sweep',
          'risk_push',
          'fact_check',
          'news_ingest',
        ],
        p_worker_id: 'w1',
      },
    });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]!).toMatchObject({ id: 'hb-1', patch: { status: 'done' } });
    expect(
      logger.calls.find((c) => (c.obj as { event?: string }).event === 'scheduler.heartbeat'),
    ).toBeDefined();
  });

  it('retries with exponential backoff when a handler throws (attempts < max)', async () => {
    const r = row({ id: 'hb-2', attempts: 2, max_attempts: 5 });
    const supabase = buildSupabase({ claimReturn: [r] });
    const logger = buildLogger();
    const handlers: Record<string, JobHandler> = {
      heartbeat: vi.fn(() => Promise.reject(new Error('boom'))),
    };

    const result = await runSchedulerTick({
      supabase: supabase.client,
      logger,
      workerId: 'w1',
      handlers,
    });

    expect(result).toMatchObject({ claimed: 1, retried: 1, succeeded: 0, deadLettered: 0 });
    expect(supabase.updates).toHaveLength(1);
    const patch = supabase.updates[0]!.patch as Record<string, unknown>;
    expect(patch.status).toBe('pending');
    expect(patch.last_error).toBe('boom');
    expect(typeof patch.available_at).toBe('string');
    // attempts=2 -> 2x base (5s * 2 = 10s) per backoffMsFor.
    expect(__testing.backoffMsFor(2)).toBe(10_000);
  });

  it('dead-letters when attempts hit max_attempts', async () => {
    const r = row({ id: 'hb-3', attempts: 5, max_attempts: 5 });
    const supabase = buildSupabase({ claimReturn: [r] });
    const logger = buildLogger();
    const handlers: Record<string, JobHandler> = {
      heartbeat: () => Promise.reject(new Error('still broken')),
    };

    const result = await runSchedulerTick({
      supabase: supabase.client,
      logger,
      workerId: 'w1',
      handlers,
    });

    expect(result).toMatchObject({ claimed: 1, deadLettered: 1, retried: 0, succeeded: 0 });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]!.patch).toMatchObject({
      status: 'dead',
      last_error: 'still broken',
    });
    expect(
      logger.calls.find((c) => (c.obj as { event?: string }).event === 'scheduler.dead_letter'),
    ).toBeDefined();
  });

  it('reaps stale processing rows back to pending', async () => {
    const supabase = buildSupabase({ reapResult: [{ id: 'stuck-1' }, { id: 'stuck-2' }] });
    const logger = buildLogger();

    const result = await runSchedulerTick({
      supabase: supabase.client,
      logger,
      workerId: 'w1',
      handlers: defaultHandlers,
    });

    expect(result.reapedStale).toBe(2);
  });

  it('claim filter only includes registered handler types', async () => {
    const supabase = buildSupabase({ claimReturn: [] });
    const logger = buildLogger();
    const handlers: Record<string, JobHandler> = {
      heartbeat: heartbeatHandler,
      drop_publish: heartbeatHandler,
    };

    await runSchedulerTick({ supabase: supabase.client, logger, workerId: 'w1', handlers });

    expect(supabase.rpcCalls[0]!.args.p_handler_types).toEqual(['heartbeat', 'drop_publish']);
  });

  it('skips the claim RPC entirely when no handlers are registered', async () => {
    const supabase = buildSupabase({ claimReturn: [] });
    const logger = buildLogger();

    const result = await runSchedulerTick({
      supabase: supabase.client,
      logger,
      workerId: 'w1',
      handlers: {},
    });

    expect(result.claimed).toBe(0);
    expect(supabase.rpcCalls).toHaveLength(0);
  });
});

describe('backoffMsFor', () => {
  it('exponential from 5s, capped at 5 min', () => {
    expect(__testing.backoffMsFor(1)).toBe(5_000);
    expect(__testing.backoffMsFor(2)).toBe(10_000);
    expect(__testing.backoffMsFor(3)).toBe(20_000);
    expect(__testing.backoffMsFor(4)).toBe(40_000);
    expect(__testing.backoffMsFor(8)).toBe(__testing.STALE_LOCK_MS / 2);
    // Capped at 5 min:
    expect(__testing.backoffMsFor(20)).toBe(5 * 60 * 1000);
  });
});
