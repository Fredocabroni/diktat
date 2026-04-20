// Server-side Supabase client bound to the request's Next.js cookies.
// Used from Server Components + Route Handlers. The `cookies()` API is
// async in Next 15 — we await it here so callers don't have to know
// about the adapter shape.

import { createServerSupabaseClient } from '@diktat/auth';
import { cookies } from 'next/headers';

import { clientEnv } from '../env';

export async function getServerSupabaseClient() {
  const cookieStore = await cookies();
  return createServerSupabaseClient({
    url: clientEnv.SUPABASE_URL,
    anonKey: clientEnv.SUPABASE_ANON_KEY,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        for (const { name, value, options } of items) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // `cookies().set` throws when called from a Server Component.
            // Middleware + Route Handlers can set cookies; Server
            // Components read only. Swallow so a read-only render
            // doesn't blow up when Supabase rotates its refresh token.
          }
        }
      },
    },
  });
}
