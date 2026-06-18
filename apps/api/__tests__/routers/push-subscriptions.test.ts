import { describe, expect, it, vi } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import * as supabaseModule from '../../src/supabase.js';
import { fakeDb, makeCtx } from '../helpers.js';

const VALID_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

describe('pushSubscriptionsRouter.register — input validation', () => {
  it('rejects non-https endpoints', async () => {
    const { db } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.pushSubscriptions.register({
        endpoint: 'http://fcm.googleapis.com/fcm/send/abc',
        p256dh: 'p',
        auth: 'a',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects loopback endpoints (SSRF defense)', async () => {
    const { db } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));
    await expect(
      caller.pushSubscriptions.register({
        endpoint: 'https://127.0.0.1/x',
        p256dh: 'p',
        auth: 'a',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects private IP endpoints (SSRF defense)', async () => {
    const { db } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));
    for (const host of ['192.168.1.1', '10.0.0.1', '172.16.0.1', '169.254.1.1']) {
      await expect(
        caller.pushSubscriptions.register({
          endpoint: `https://${host}/x`,
          p256dh: 'p',
          auth: 'a',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('rejects IPv6 loopback variants + alternate IPv4 encodings (SSRF defense)', async () => {
    const { db } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const ssrfHosts = [
      // IPv6 loopback variants
      'https://[::1]/x',
      'https://[0:0:0:0:0:0:0:1]/x',
      'https://[::ffff:127.0.0.1]/x',
      // IPv6 link-local / unique-local / NAT64
      'https://[fe80::1]/x',
      'https://[fc00::1]/x',
      'https://[64:ff9b::]/x',
      // Alternate IPv4 encodings for 127.0.0.1
      'https://2130706433/x',
      'https://0x7f000001/x',
      'https://127.1/x',
      // Public-but-not-push-service host (DNS rebinding class)
      'https://evil.example.com/x',
    ];
    for (const url of ssrfHosts) {
      await expect(
        caller.pushSubscriptions.register({ endpoint: url, p256dh: 'p', auth: 'a' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('accepts each known push-service host suffix', async () => {
    const { db: service } = fakeDb('user_push_subscriptions', {
      data: { id: 'sub-1', endpoint: 'placeholder', created_at: '2026-06-15T20:00:00Z' },
      error: null,
    });
    const spy = vi
      .spyOn(supabaseModule, 'serviceRoleClient')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue(service as any);
    const { db } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const okEndpoints = [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-bl2p.notify.windows.com/?token=abc',
      'https://db5.notify.windows.com/?token=abc',
    ];
    // Valid base64url-shaped keys so the post-SSRF keySchema validates.
    const validP256dh =
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
    const validAuth = 'tBHItJI5svbpez7KI4CCXg';
    for (const ep of okEndpoints) {
      await caller.pushSubscriptions.register({
        endpoint: ep,
        p256dh: validP256dh,
        auth: validAuth,
      });
    }
    spy.mockRestore();
  });

  it('UPSERTs through the service-role client, always with ctx.userId', async () => {
    const { db: service, calls } = fakeDb('user_push_subscriptions', {
      data: { id: 'sub-1', endpoint: VALID_ENDPOINT, created_at: '2026-06-15T20:00:00Z' },
      error: null,
    });
    const spy = vi
      .spyOn(supabaseModule, 'serviceRoleClient')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue(service as any);
    const { db: userDb } = fakeDb('user_push_subscriptions', { data: null, error: null });

    const caller = appRouter.createCaller(makeCtx({ db: userDb }));
    const result = await caller.pushSubscriptions.register({
      endpoint: VALID_ENDPOINT,
      p256dh: 'p256dh-1',
      auth: 'auth-1',
      userAgent: 'Mozilla/5.0',
    });

    expect(result.id).toBe('sub-1');
    const upsertCall = calls.ops.find((op) => op.op === 'upsert');
    expect(upsertCall).toBeDefined();
    const row = upsertCall!.args[0] as Record<string, unknown>;
    expect(row.user_id).toBe('user-123'); // ctx.userId — never client-supplied
    expect(row.endpoint).toBe(VALID_ENDPOINT);
    expect(row.disabled_at).toBeNull(); // resurrection of any soft-deleted row
    expect(row.disabled_reason).toBeNull();

    spy.mockRestore();
  });

  it('UNAUTHORIZED for unauthed callers', async () => {
    const { db } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));
    await expect(
      caller.pushSubscriptions.register({
        endpoint: VALID_ENDPOINT,
        p256dh: 'p',
        auth: 'a',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('pushSubscriptionsRouter.unregister', () => {
  it('DELETEs through the user-scoped db (RLS enforces is_self)', async () => {
    const { db, calls } = fakeDb('user_push_subscriptions', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.pushSubscriptions.unregister({ endpoint: VALID_ENDPOINT });
    expect(result).toEqual({ ok: true });
    expect(calls.ops.some((op) => op.op === 'delete')).toBe(true);
    // Two eq() calls: one on user_id, one on endpoint.
    const eqOps = calls.ops.filter((op) => op.op === 'eq');
    expect(eqOps.length).toBe(2);
  });
});

describe('userRouter.updateNotificationPreferences', () => {
  // updateNotificationPreferences now routes through SECURITY DEFINER
  // `update_notification_preferences(p_prefs jsonb)` (migration
  // 20260618170000). The merge with existing preferences happens
  // ATOMICALLY inside the function body — the router just forwards
  // the partial patch. So the assertion shape changes: verify the
  // router sends the right partial, not the result of a router-side
  // read-modify-write.
  it('forwards the partial patch (streak_risk_push only) to the rpc', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const rpcCalls: { fn: string; args: unknown }[] = [];
    // Override the rpc method to capture calls.
    (db as unknown as { rpc: (fn: string, args?: unknown) => unknown }).rpc = (
      fn: string,
      args?: unknown,
    ) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({
        data: { _seen_intro: true, streak_risk_push: false },
        error: null,
      });
    };
    const caller = appRouter.createCaller(makeCtx({ db }));

    await caller.user.updateNotificationPreferences({ streakRiskPush: false });

    expect(rpcCalls).toEqual([
      { fn: 'update_notification_preferences', args: { p_prefs: { streak_risk_push: false } } },
    ]);
  });

  it('UNAUTHORIZED for unauthed callers', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));
    await expect(
      caller.user.updateNotificationPreferences({ streakRiskPush: false }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
