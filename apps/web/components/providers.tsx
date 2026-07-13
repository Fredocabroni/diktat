// App-wide client providers. Wraps React Query + tRPC with a shared query
// client. The tRPC httpBatchLink injects the current Supabase access token
// on every request so the Fastify API can run JWT verification + RLS.

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, loggerLink } from '@trpc/client';
import { LazyMotion, domAnimation } from 'framer-motion';
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
      <QueryClientProvider client={queryClient}>
        {/*
          LazyMotion loads Framer Motion's animation features once, lazily,
          instead of the full `motion` bundle per component. Wraps the whole
          app (both the (app) shell and the onboarding/login routes, which
          live outside it) since Providers is the single root client boundary.
          `strict` makes `motion.*` throw — every animated element must use the
          lightweight `m.*` component, keeping the per-route bundle small.
          domAnimation = animations + variants + exit (no drag/layout); bump to
          domMax when swipe/drag gestures land.
        */}
        <LazyMotion features={domAnimation} strict>
          {children}
        </LazyMotion>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
