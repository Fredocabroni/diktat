// Browser-side Supabase client. Use only in client components / browser
// bundles. The cookie store is the browser's own — no adapter required.

import { createBrowserClient } from '@supabase/ssr';

import type { Database } from '@diktat/db';

export type BrowserSupabaseClient = ReturnType<typeof createBrowserClient<Database>>;

export interface BrowserSupabaseClientOptions {
  /** Supabase project URL — `process.env.NEXT_PUBLIC_SUPABASE_URL`. */
  readonly url: string;
  /** Public anon key — `process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY`. */
  readonly anonKey: string;
}

export function createBrowserSupabaseClient(
  opts: BrowserSupabaseClientOptions,
): BrowserSupabaseClient {
  return createBrowserClient<Database>(opts.url, opts.anonKey);
}
