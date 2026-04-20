// Factory helpers for constructing request-scoped Supabase clients.
//
// Two shapes:
//   - userScopedClient: carries the caller's Authorization header so every
//     query/mutation runs through RLS as that user. This is the normal path
//     for router procedures.
//   - serviceRoleClient: bypasses RLS. Only used by privileged writes (none
//     in this PR). Constructed lazily so the service-role key is never in
//     memory when it's not needed.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@diktat/db';

import type { Env } from './env.js';

export type DbClient = SupabaseClient<Database>;

export function userScopedClient(env: Env, bearerToken: string | null): DbClient {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(bearerToken ? { global: { headers: { Authorization: `Bearer ${bearerToken}` } } } : {}),
  });
}

export function serviceRoleClient(env: Env): DbClient {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
