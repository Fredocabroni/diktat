// Push subscriptions router. The settings UI calls `register` after the
// browser hands back a PushSubscription from pushManager.subscribe(); calls
// `unregister` when the user explicitly removes a device. Per-user opt-out
// (the "On/Off" toggle) flips users.notification_preferences via the user
// router's updateNotificationPreferences mutation — it does NOT touch the
// subscription row, so re-enabling later doesn't re-prompt for permission.
//
// Soft-delete vs hard-delete:
//   - Worker-initiated (410/404/401 from the push service) is a soft-delete
//     UPDATE via the workers' service-role client. RLS blocks self-update
//     of disabled_at / disabled_reason for this exact reason — only the
//     worker can mark a sub "gone" / "unauthorized" without polluting the
//     audit signal.
//   - User-initiated "remove this device" is a hard-DELETE via the user's
//     JWT, gated by the self-DELETE RLS policy. The UI uses this when the
//     user wants the device out of the table entirely.
//
// `register` UPSERTs on (user_id, endpoint) and clears any prior
// disabled_at / disabled_reason, so a previously soft-deleted endpoint
// (e.g. after VAPID rotation) is resurrected by a normal re-subscribe.
// That UPSERT requires bypassing the column-level RLS that blocks self
// UPDATEs of disabled_*, so the mutation runs through the service-role
// client. ctx.userId is the only user-id that ever lands on the row.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { protectedProcedure, router } from '../trpc.js';
import { serviceRoleClient } from '../supabase.js';

// Endpoint validation. The push service hands the browser an opaque HTTPS
// URL; the workers process then POSTs a VAPID-signed envelope to it. To
// keep the egress surface tight we enforce:
//   - https (never http — VAPID requires TLS to the push service)
//   - max 2KB (the WebPush spec caps endpoint URL length around this;
//     longer is almost certainly malicious or malformed)
//   - hostname must match a host-suffix allow-list of the four mainstream
//     browser push services. This collapses every SSRF bypass class —
//     IPv6 loopback variants, IPv4 alternate encodings (decimal, octal,
//     hex, short-form), DNS rebinding to a public name that resolves to
//     127.x or RFC1918, link-local IPv6 (fe80::/10), unique-local (fc00::/7),
//     and NAT64 (64:ff9b::/96). None of those can be an FCM / Mozilla
//     autopush / Apple Web Push / Microsoft WNS hostname, so an exact-
//     suffix check is the strongest available defense. If a new browser
//     ships a different push endpoint host, this list needs an update —
//     that's the deliberate trade-off (security-reviewer ask, 2026-06-15).
//
// Allow-list:
//   - fcm.googleapis.com                     — Chrome / most browsers
//   - updates.push.services.mozilla.com      — Firefox autopush
//   - web.push.apple.com                     — Safari iOS/macOS
//   - *.notify.windows.com                   — Microsoft WNS (datacenter-
//                                              prefixed: wns2-*, db5-*,
//                                              etc.)
const ENDPOINT_MAX_LEN = 2048;
const ALLOWED_EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const ALLOWED_HOST_SUFFIXES = ['.notify.windows.com'];

function hostnameInAllowList(host: string): boolean {
  const lower = host.toLowerCase();
  if (ALLOWED_EXACT_HOSTS.has(lower)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

const endpointSchema = z
  .string()
  .min(1)
  .max(ENDPOINT_MAX_LEN, 'Endpoint URL too long.')
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol !== 'https:') return false;
      return hostnameInAllowList(url.hostname);
    },
    { message: 'Endpoint must be a known push-service URL.' },
  );

// p256dh + auth are base64url-encoded byte strings from the browser's
// PushSubscription.getKey(). RFC 8291 specifies fixed byte sizes:
//   - p256dh: 65 bytes (uncompressed P-256 point) → 88 chars base64url
//   - auth:   16 bytes (per-subscription secret)  → ~22-24 chars base64url
// Bound the regex to base64url-safe characters and a reasonable max so
// garbage keys are rejected at register-time rather than silently wasting
// the workers' send budget on guaranteed-transient failures (security-
// reviewer follow-up, 2026-06-15).
const BASE64URL_RE = /^[A-Za-z0-9_-]+=*$/;
const keySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(BASE64URL_RE, 'Push subscription key must be base64url.');

const registerInput = z.object({
  endpoint: endpointSchema,
  p256dh: keySchema,
  auth: keySchema,
  userAgent: z.string().max(500).optional(),
});

const unregisterInput = z.object({
  endpoint: endpointSchema,
});

export const pushSubscriptionsRouter = router({
  // Register a new subscription, or resurrect a previously soft-deleted one
  // for the same (user, endpoint) pair. Service-role write because the
  // UPSERT must clear disabled_at / disabled_reason — fields RLS blocks
  // self-UPDATE of. ctx.userId is the only user_id ever written.
  register: protectedProcedure.input(registerInput).mutation(async ({ ctx, input }) => {
    const service = serviceRoleClient(ctx.env);
    const { data, error } = await service
      .from('user_push_subscriptions')
      .upsert(
        {
          user_id: ctx.userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          user_agent: input.userAgent ?? null,
          disabled_at: null,
          disabled_reason: null,
        },
        { onConflict: 'user_id,endpoint' },
      )
      .select('id, endpoint, created_at')
      .maybeSingle();

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to register push subscription.',
        cause: error,
      });
    }
    if (!data) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'No row returned.' });
    }
    return data;
  }),

  // Hard-delete the subscription. RLS DELETE policy on user_push_subscriptions
  // gates this to is_self(user_id), so even a hostile caller can only remove
  // their own rows.
  unregister: protectedProcedure.input(unregisterInput).mutation(async ({ ctx, input }) => {
    const { error } = await ctx.db
      .from('user_push_subscriptions')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('endpoint', input.endpoint);

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to remove push subscription.',
        cause: error,
      });
    }
    return { ok: true };
  }),

  // List the caller's subscriptions. Used by the settings UI to render
  // "remove device" rows. RLS SELECT policy gates by is_self(user_id).
  listMine: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from('user_push_subscriptions')
      .select(
        'id, endpoint, user_agent, created_at, last_delivered_at, disabled_at, disabled_reason',
      )
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load push subscriptions.',
        cause: error,
      });
    }
    return data ?? [];
  }),
});
