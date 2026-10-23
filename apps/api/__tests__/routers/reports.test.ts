// Tests for the reports.submit mutation: input validation, RPC
// invocation shape, sqlstate → tRPCError mapping, and the fire-and-
// forget Telegram alert.

import { TRPCError } from '@trpc/server';
import type { Alerter } from '@diktat/shared/alerts';
import { describe, expect, it, vi } from 'vitest';

import type { Context } from '../../src/context.js';
import { _resetReportsAlerterForTests } from '../../src/routers/reports.js';
import { appRouter } from '../../src/routers/index.js';
import { fakeRedis, makeCtx } from '../helpers.js';

function reportsDb(opts: {
  readonly rpc?: { data?: unknown; error?: { code?: string; message: string } | null };
}): Context['db'] {
  return {
    from: (t: string) => {
      throw new Error(`reportsDb: unexpected from("${t}")`);
    },
    rpc: (fn: string) => {
      if (fn === 'submit_report') {
        if (!opts.rpc) throw new Error('reportsDb: submit_report called with no stub');
        return Promise.resolve({
          data: opts.rpc.data ?? null,
          error: opts.rpc.error ?? null,
        });
      }
      if (fn === 'get_user_self') {
        // mutation-wide age-gate middleware calls this.
        return {
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: 'user-123',
                age_verified_at: new Date().toISOString(),
                age_blocked_at: null,
              },
              error: null,
            }),
        };
      }
      throw new Error(`reportsDb: unexpected rpc("${fn}")`);
    },
  } as unknown as Context['db'];
}

function stubAlerter(): Alerter & { calls: Parameters<Alerter['alert']>[] } {
  const calls: Parameters<Alerter['alert']>[] = [];
  const alerter: Alerter & { calls: typeof calls } = {
    enabled: true,
    alert: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
    calls,
  };
  return alerter;
}

describe('reports.submit', () => {
  it('inserts via submit_report RPC and returns reportId', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: 'report-uuid-1', error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000001',
      reason: 'spam',
    });
    expect(r).toEqual({ outcome: 'submitted', reportId: 'report-uuid-1' });
  });

  it('fires a Telegram alert after a successful insert (fire-and-forget)', async () => {
    const alerter = stubAlerter();
    _resetReportsAlerterForTests(alerter);
    const db = reportsDb({ rpc: { data: 'report-uuid-2', error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000002',
      reason: 'spam',
    });
    // The alert IS invoked synchronously by the resolver (we `void`
    // the returned promise). The call shows up in the stub immediately.
    expect(alerter.calls).toHaveLength(1);
    const [severity, title, detail, opts] = alerter.calls[0]!;
    expect(severity).toBe('warn');
    expect(title).toBe('Content report');
    expect(detail).toMatch(/debate_arg/);
    expect(detail).toMatch(/00000000-0000-4000-8000-000000000002/);
    expect(opts).toMatchObject({
      dedupKey: 'report:debate_arg:00000000-0000-4000-8000-000000000002',
    });
  });

  it('does NOT leak reporter email or payload — only reporter user ID + reason snippet', async () => {
    const alerter = stubAlerter();
    _resetReportsAlerterForTests(alerter);
    const db = reportsDb({ rpc: { data: 'r3', error: null } });
    const caller = appRouter.createCaller(
      makeCtx({ db, redis: fakeRedis(), userId: 'reporter-xyz' }),
    );
    await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000003',
      reason: 'very long reason '.repeat(50),
    });
    const [, , detail] = alerter.calls[0]!;
    expect(detail).toContain('reporter-xyz');
    // 500 char cap on the reason snippet keeps the alert succinct.
    expect(detail.length).toBeLessThan(2000);
    expect(detail).not.toContain('@');
  });

  it('rejects empty / whitespace reason at the Zod boundary (BAD_REQUEST)', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: 'should-not-fire', error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-000000000004',
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('maps RPC sqlstate 22023 → BAD_REQUEST', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: null, error: { code: '22023', message: 'bad' } } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-000000000005',
        reason: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps RPC sqlstate 28000 → UNAUTHORIZED', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: null, error: { code: '28000', message: 'anon' } } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-000000000006',
        reason: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('maps unknown RPC error → INTERNAL_SERVER_ERROR with a generic user-facing message', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: null, error: { code: 'XX000', message: 'boom' } } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-000000000007',
        reason: 'ok',
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: "Report didn't save. Try again.",
    });
  });

  it('does NOT fire a Telegram alert on failure', async () => {
    const alerter = stubAlerter();
    _resetReportsAlerterForTests(alerter);
    const db = reportsDb({ rpc: { data: null, error: { code: '22023', message: 'bad' } } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-000000000008',
        reason: 'ok',
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(alerter.calls).toHaveLength(0);
  });
});
