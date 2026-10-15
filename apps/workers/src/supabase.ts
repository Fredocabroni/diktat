// Service-role Supabase client for workers. Bypasses RLS — only used by
// privileged writes (Privy wallet UPDATE, AP settlement, trivia inserts).
//
// Parameterized with the generated `Database` type from `@diktat/db` so
// every workers call-site gets compile-time arg/return-shape checking
// without a per-site `as unknown as SupabaseClient<Database>` cast
// (closes #215 LOW 1 — the news-ingest.ts double-cast at the
// upsert_gdelt_event_mention RPC call-site).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@diktat/db';

import type { Env } from './env.js';

export type ServiceClient = SupabaseClient<Database>;

export function buildServiceClient(env: Env): ServiceClient {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
