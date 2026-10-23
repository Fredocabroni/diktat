// Tests for the reports.submit mutation: input validation, RPC
// invocation shape, sqlstate → tRPCError mapping, and the fire-and-
// forget Telegram alert.

import { TRPCError } from '@trpc/server';
import type { Alerter } from '@diktat/shared/alerts';
import { describe, expect, it } from 'vitest';

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

const OK = { outcome: 'submitted', id: 'report-uuid-1' } as const;

describe('reports.submit', () => {
  it('inserts via submit_report RPC and returns {outcome, reportId}', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: OK, error: null } });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000001',
      reason: 'spam',
    });
    expect(r).toEqual({ outcome: 'submitted', reportId: 'report-uuid-1' });
  });

  it("returns outcome='already_reported' with the existing id on a duplicate (quiet success)", async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({
      rpc: { data: { outcome: 'already_reported', id: 'existing-r1' }, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    const r = await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000001',
      reason: 'spam again',
    });
    expect(r).toEqual({ outcome: 'already_reported', reportId: 'existing-r1' });
  });

  it('fires a Telegram alert after a successful insert (fire-and-forget)', async () => {
    const alerter = stubAlerter();
    _resetReportsAlerterForTests(alerter);
    const db = reportsDb({
      rpc: { data: { outcome: 'submitted', id: 'report-uuid-2' }, error: null },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000002',
      reason: 'spam',
    });
    expect(alerter.calls).toHaveLength(1);
    const [severity, title, detail, opts] = alerter.calls[0]!;
    expect(severity).toBe('warn');
    expect(title).toBe('Content report');
    expect(detail).toMatch(/debate_arg/);
    expect(detail).toMatch(/00000000-0000-4000-8000-000000000002/);
    expect(detail).toMatch(/report-uuid-2/);
    expect(detail).toMatch(/Link:\s+https?:\/\/[^\s]+\/admin\/reports\/report-uuid-2/);
    expect(opts).toMatchObject({
      dedupKey: 'report:debate_arg:00000000-0000-4000-8000-000000000002',
    });
  });

  it('the Telegram alert does NOT contain the reason text (data minimisation)', async () => {
    const alerter = stubAlerter();
    _resetReportsAlerterForTests(alerter);
    const db = reportsDb({
      rpc: { data: { outcome: 'submitted', id: 'r3' }, error: null },
    });
    const caller = appRouter.createCaller(
      makeCtx({ db, redis: fakeRedis(), userId: 'reporter-xyz' }),
    );
    const needle = 'UNIQUE-REASON-TEXT-ABC123';
    await caller.reports.submit({
      targetType: 'debate_arg',
      targetId: '00000000-0000-4000-8000-000000000003',
      reason: `${needle} ${'x'.repeat(50)}`,
    });
    const [, , detail] = alerter.calls[0]!;
    expect(detail).not.toContain(needle);
    // "Reason:" label is also gone from the alert body.
    expect(detail).not.toMatch(/Reason:/i);
    // The alert surface should carry no email or `@` character.
    expect(detail).not.toContain('@');
  });

  it('rejects empty / whitespace reason at the Zod boundary (BAD_REQUEST)', async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({ rpc: { data: OK, error: null } });
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

  it("maps P0001 'rate_limited' → TOO_MANY_REQUESTS", async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({
      rpc: { data: null, error: { code: 'P0001', message: 'reports: rate_limited' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-00000000000a',
        reason: 'ok',
      }),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many reports in the last hour. Try again later.',
    });
  });

  it("maps P0001 'age_not_verified' → FORBIDDEN", async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({
      rpc: { data: null, error: { code: 'P0001', message: 'reports: age_not_verified' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-00000000000b',
        reason: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("maps P0001 'target_not_found' → NOT_FOUND", async () => {
    _resetReportsAlerterForTests(stubAlerter());
    const db = reportsDb({
      rpc: { data: null, error: { code: 'P0001', message: 'reports: target_not_found' } },
    });
    const caller = appRouter.createCaller(makeCtx({ db, redis: fakeRedis() }));
    await expect(
      caller.reports.submit({
        targetType: 'debate_arg',
        targetId: '00000000-0000-4000-8000-00000000000c',
        reason: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
