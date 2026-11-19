// Server-only service-role Supabase client. Used by /admin surfaces to
// read reports (which have RLS deny-by-default) and call moderation
// RPCs that are granted to service_role only. Never import this from a
// Client Component — the key would land in the browser bundle.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { clientEnv } from '../env';

export function getServiceRoleSupabaseClient(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(clientEnv.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
