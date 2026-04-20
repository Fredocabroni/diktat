// Browser Supabase client bound to NEXT_PUBLIC_* env. Singleton per tab
// so React re-renders don't create a new auth listener on every mount.

'use client';

import { createBrowserSupabaseClient, type BrowserSupabaseClient } from '@diktat/auth';

import { clientEnv } from '../env';

let instance: BrowserSupabaseClient | null = null;

export function getBrowserSupabaseClient(): BrowserSupabaseClient {
  if (!instance) {
    instance = createBrowserSupabaseClient({
      url: clientEnv.SUPABASE_URL,
      anonKey: clientEnv.SUPABASE_ANON_KEY,
    });
  }
  return instance;
}
