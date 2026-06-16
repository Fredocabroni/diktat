// Browser-side helpers for the Web Push subscription dance.
//
// The settings UI orchestrates four explicit user actions:
//   - probeSupport() / Notification.permission — render the right toggle state.
//   - enablePush() — request permission, subscribe via PushManager, register
//     with the API. Idempotent across multiple calls.
//   - disablePush() — unsubscribe the PushSubscription locally + DELETE the
//     row server-side via tRPC. The browser stops holding the subscription.
//   - serializeSubscription() — convert the PushSubscription object into the
//     plain { endpoint, p256dh, auth } shape the API mutation expects.
//
// All decisions live in the page that calls these helpers; this module is
// stateless plumbing.

'use client';

import { clientEnv } from './env';

export type PushSupportStatus =
  | 'supported'
  | 'unsupported_browser'
  | 'no_service_worker'
  | 'no_vapid_key';

export interface SerializedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Detects feature-availability — never asks for permission. */
export function probeSupport(): PushSupportStatus {
  if (typeof window === 'undefined') return 'unsupported_browser';
  if (!('serviceWorker' in navigator)) return 'no_service_worker';
  if (!('PushManager' in window)) return 'unsupported_browser';
  if (!('Notification' in window)) return 'unsupported_browser';
  if (clientEnv.VAPID_PUBLIC_KEY.length === 0) return 'no_vapid_key';
  return 'supported';
}

/** Read the current Notification.permission state without requesting. */
export function getPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** Read the currently-registered PushSubscription, if any. Does NOT request. */
export async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (probeSupport() !== 'supported') return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Request permission + subscribe via PushManager. Returns the subscription
 *  on success or null if the user denied. Caller is responsible for sending
 *  the serialized form to the server via tRPC. */
export async function enablePush(): Promise<PushSubscription | null> {
  const support = probeSupport();
  if (support !== 'supported') {
    throw new Error(`push.enable: ${support}`);
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;

  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    // PushSubscribeOptions wants BufferSource over ArrayBuffer specifically;
    // TS 5's Uint8Array<ArrayBufferLike> doesn't unify with that. The raw
    // bytes are inert key material — cast is safe.
    applicationServerKey: urlBase64ToUint8Array(
      clientEnv.VAPID_PUBLIC_KEY,
    ) as unknown as BufferSource,
  });
}

/** Unsubscribe the local PushSubscription. Returns the endpoint of the
 *  subscription that was removed (caller passes this to the API unregister
 *  mutation), or null if there was no active subscription. */
export async function disablePush(): Promise<string | null> {
  const sub = await getActiveSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

/** Serialize a PushSubscription into the { endpoint, p256dh, auth } shape
 *  the pushSubscriptions.register tRPC mutation accepts. */
export function serializeSubscription(sub: PushSubscription): SerializedSubscription {
  const p256dh = arrayBufferToBase64Url(sub.getKey('p256dh'));
  const auth = arrayBufferToBase64Url(sub.getKey('auth'));
  if (!p256dh || !auth) {
    throw new Error('push.serialize: subscription missing p256dh or auth key');
  }
  return { endpoint: sub.endpoint, p256dh, auth };
}

// ---------------------------------------------------------------------------
// Encoding helpers — VAPID exchange uses base64url, the Web Crypto APIs
// expose ArrayBuffer; bridge them here.
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string | null {
  if (!buffer) return null;
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
