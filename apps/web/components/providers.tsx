// App-wide client providers. Wraps React Query + tRPC with a shared query
// client. The tRPC httpBatchLink injects the current Supabase access token
// on every request so the Fastify API can run JWT verification + RLS.

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, loggerLink } from '@trpc/client';
import { useState } from 'react';
import superjson from 'superjson';

import { clientEnv } from '../lib/env';
import { getBrowserSupabaseClient } from '../lib/supabase/browser';
import { trpc } from '../lib/trpc';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Mobile users re-open the app constantly; default 0 stale-
            // time means we'd refetch on every focus. 30s balances fresh
            // data with network savings.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === 'development' ||
            (opts.direction === 'down' && opts.result instanceof Error),
        }),
        httpBatchLink({
          url: `${clientEnv.API_URL}/trpc`,
          transformer: superjson,
          async headers() {
            const supabase = getBrowserSupabaseClient();
            const {
              data: { session },
            } = await supabase.auth.getSession();
            if (!session?.access_token) return {};
            return { Authorization: `Bearer ${session.access_token}` };
          },
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
