import { describe, expect, it, vi } from 'vitest';

import {
  GDELT_CLUSTER_RETENTION_HOURS,
  gdeltEventRetentionHandler,
} from '../../src/jobs/gdelt-event-retention.js';
import type { Logger } from '../../src/logger.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { ServiceClient } from '../../src/supabase.js';

interface LogCall {
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly obj: Record<string, unknown>;
}

function buildLogger(): Logger & { calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    (level: LogCall['level']) =>
    (obj: Record<string, unknown>): void => {
      calls.push({ level, obj });
    };
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  } as Logger & { calls: LogCall[] };
}

function buildRow(): ScheduledJobRow {
  return {
    id: 'job-1',
    job_type: 'gdelt_event_retention',
    idempotency_key: 'retention:2026-10-13T00:00:00Z',
    target_user_id: null,
    payload: {},
    status: 'in_progress',
    attempts: 1,
    max_attempts: 3,
    available_at: '2026-10-13T00:00:00Z',
    locked_at: '2026-10-13T00:00:00Z',
    locked_by: 'test-worker',
    last_error: null,
    processed_at: null,
    created_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:00:00Z',
  } as unknown as ScheduledJobRow;
}

describe('gdeltEventRetentionHandler', () => {
  it('uses a 24-hour retention window per operator spec', () => {
    expect(GDELT_CLUSTER_RETENTION_HOURS).toBe(24);
  });

  it('DELETEs from gdelt_event_cluster where last_seen_at < now()-24h', async () => {
    const captured: Array<{ table: string; cutoff: string | null }> = [];
    const supabase = {
      from(table: string) {
        return {
          delete() {
            return {
              lt(_col: string, cutoff: string) {
                captured.push({ table, cutoff });
                return Promise.resolve({ error: null, count: 3 });
              },
            };
          },
        };
      },
    } as unknown as ServiceClient;
    const logger = buildLogger();
    await gdeltEventRetentionHandler(buildRow(), {
      supabase,
      logger,
      fetch: vi.fn() as never,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.table).toBe('gdelt_event_cluster');
    // cutoff ~ now - 24h; ensure the value parses + is before now.
    const cutoff = new Date(captured[0]!.cutoff as string);
    expect(Number.isNaN(cutoff.getTime())).toBe(false);
    expect(cutoff.getTime()).toBeLessThan(Date.now());
    const expected = Date.now() - 24 * 3600 * 1000;
    // Should be within 5s of expected cutoff.
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
    // Logs deleted count.
    expect(
      logger.calls.find((c) => c.obj.event === 'gdelt_event_retention.swept')?.obj,
    ).toMatchObject({
      deleted: 3,
      retention_hours: 24,
    });
  });

  it('throws when supabase delete returns an error (scheduler retries)', async () => {
    const supabase = {
      from() {
        return {
          delete() {
            return {
              lt() {
                return Promise.resolve({ error: { message: 'db down' }, count: null });
              },
            };
          },
        };
      },
    } as unknown as ServiceClient;
    const logger = buildLogger();
    await expect(
      gdeltEventRetentionHandler(buildRow(), {
        supabase,
        logger,
        fetch: vi.fn() as never,
      }),
    ).rejects.toThrow(/delete failed: db down/);
  });
});
