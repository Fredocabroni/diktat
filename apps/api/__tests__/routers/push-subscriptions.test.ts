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
    for (const ep of okEndpoints) {
      await caller.pushSubscriptions.register({ endpoint: ep, p256dh: 'p', auth: 'a' });
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
  it('merges streak_risk_push into existing prefs (read-modify-write)', async () => {
    // First op = SELECT current prefs. Second op = UPDATE merged prefs.
    // The fake fakeDb shares a single result across all ops, so we cheat
    // by returning the merged result on every call — the assertion is
    // about what was PASSED to update().
    const { db, calls } = fakeDb('users', {
      data: {
        notification_preferences: { _seen_intro: true, streak_risk_push: true },
      },
      error: null,
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await caller.user.updateNotificationPreferences({ streakRiskPush: false });

    const updateOp = calls.ops.find((op) => op.op === 'update');
    expect(updateOp).toBeDefined();
    const patch = updateOp!.args[0] as { notification_preferences: Record<string, unknown> };
    // Pre-existing key preserved.
    expect(patch.notification_preferences._seen_intro).toBe(true);
    // New key applied.
    expect(patch.notification_preferences.streak_risk_push).toBe(false);
  });

  it('UNAUTHORIZED for unauthed callers', async () => {
    const { db } = fakeDb('users', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db, userId: null, role: 'anon' }));
    await expect(
      caller.user.updateNotificationPreferences({ streakRiskPush: false }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
