// Service-role Supabase client for workers. Bypasses RLS — only used by
// privileged writes (Privy wallet UPDATE, AP settlement, trivia inserts).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Env } from './env.js';

export type ServiceClient = SupabaseClient;

export function buildServiceClient(env: Env): ServiceClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
