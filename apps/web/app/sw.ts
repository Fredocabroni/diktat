/// <reference lib="webworker" />
// Service worker for Diktat. Compiled by @serwist/next at build time.
// Network-first for /trpc (so mutations never see stale caches); stale-
// while-revalidate for static assets (fast first paint + background
// refresh).

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
