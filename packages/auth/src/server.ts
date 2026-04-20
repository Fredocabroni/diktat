// Server-side Supabase client for Next.js server components, route handlers,
// and middleware. Caller passes a cookie adapter so this module stays
// framework-agnostic (Next 15's `cookies()` API differs from older flavors,
// and we may want to share this with non-Next servers later).

import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';

import type { Database } from '@diktat/db';

export type ServerSupabaseClient = ReturnType<typeof createServerClient<Database>>;

/**
 * Cookie adapter supplied by the host framework. Mirrors the
 * `cookies` field of `@supabase/ssr`'s `createServerClient` so callers can
 * pass a framework-shaped object directly.
 *
 * Next.js 15 example:
 *   const store = await cookies();
 *   createServerSupabaseClient({ url, anonKey, cookies: {
 *     getAll: () => store.getAll(),
 *     setAll: (items) => items.forEach(({ name, value, options }) =>
 *       store.set(name, value, options)),
 *   } });
 */
export type CookieAdapter = CookieMethodsServer;

export interface ServerSupabaseClientOptions {
  readonly url: string;
  readonly anonKey: string;
  readonly cookies: CookieAdapter;
}

export function createServerSupabaseClient(
  opts: ServerSupabaseClientOptions,
): ServerSupabaseClient {
  return createServerClient<Database>(opts.url, opts.anonKey, {
    cookies: opts.cookies,
  });
}
