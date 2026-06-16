/// <reference lib="webworker" />
// Service worker for Diktat. Compiled by @serwist/next at build time.
// Network-first for /trpc (so mutations never see stale caches); stale-
// while-revalidate for static assets (fast first paint + background
// refresh).
//
// Web-push event handlers (push + notificationclick) live below the
// Serwist setup. The push event is fired by the browser when the workers
// process delivers via the Web Push API; we parse the JSON payload and
// hand it to showNotification(). The notificationclick handler opens or
// focuses /take5 — the deep link the body invites the user to.

import { defaultCache } from '@serwist/next/worker';
import { Serwist } from 'serwist';

// Serwist injects the precache manifest at build time.
declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (string | { url: string; revision: string | null })[];
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();

// ---------------------------------------------------------------------------
// Web-push event handlers
// ---------------------------------------------------------------------------

interface PushNotificationPayload {
  title?: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  data?: { click_action?: string };
}

self.addEventListener('push', (event) => {
  // Defensive: a push event with no payload is malformed; show a generic
  // body rather than nothing so the user can still tap through.
  const raw = event.data?.text() ?? '{}';
  let payload: PushNotificationPayload = {};
  try {
    payload = JSON.parse(raw) as PushNotificationPayload;
  } catch {
    payload = {};
  }

  const title = payload.title ?? 'Diktat';
  const options: NotificationOptions = {
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    tag: payload.tag,
    requireInteraction: payload.requireInteraction ?? false,
    data: payload.data ?? {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data as { click_action?: string } | undefined;
  const target = data?.click_action ?? '/';

  event.waitUntil(
    (async () => {
      // Prefer focusing an existing tab on the target URL; only open a new
      // window if no matching tab exists. Matches the §10 SDT autonomy bar
      // — never spam the user with extra windows.
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        try {
          const url = new URL(client.url);
          if (url.pathname === target) {
            await client.focus();
            return;
          }
        } catch {
          // ignore malformed URLs
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
