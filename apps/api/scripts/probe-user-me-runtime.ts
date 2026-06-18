// Probe whether `user.me` works at runtime against real PostgREST with a
// real authenticated bearer JWT — the production-shape access path —
// after the `users_access_column_grants` migration applies.
//
// Mirrors `probe-feed-list-runtime.ts`'s shape but targets the H1 fix:
//
//   1. forges a `role: authenticated` JWT with SUPABASE_JWT_SECRET (the
//      same shape Supabase Auth issues to real users) for an existing
//      dev `auth.users` account
//   2. builds userScopedClient with that bearer — the EXACT production
//      construction from apps/api/src/supabase.ts:19 (anon-key + bearer)
//   3. raw-probes `rpc('get_user_self')` directly so we can isolate the
//      SECURITY DEFINER + column-grant layer from any tRPC wrapping
//   4. raw-probes `.from('users').select('id, handle, …')` for the
//      column-level grant on the public subset (should succeed)
//   5. raw-probes `.from('users').select('fingerprint, notification_preferences')`
//      for the private columns (should 42501 — private columns stay
//      service-role-only at the GRANT layer)
//   6. invokes `appRouter.createCaller(ctx).user.me()` end-to-end —
//      the production read path
//
// Run:
//   (cd apps/api && set -a; . /Users/tyrionlannister/diktat/.env.local;
//    set +a; pnpm exec tsx scripts/probe-user-me-runtime.ts)

import crypto from 'crypto';

import { createClient } from '@supabase/supabase-js';

import type { Context } from '../src/context.js';
import { loadEnv } from '../src/env.js';
import { appRouter } from '../src/routers/index.js';
import { userScopedClient } from '../src/supabase.js';

function forgeAuthenticatedJwt(secret: string, subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      role: 'authenticated',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function main(): Promise<void> {
  const env = loadEnv();

  // Pick an existing dev `public.users` row to probe against.
  const sr = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: existing, error: existErr } = await sr
    .from('users')
    .select('id, handle')
    .limit(1)
    .maybeSingle();
  if (existErr || !existing) {
    console.error('No `public.users` rows on dev — cannot probe:', existErr);
    process.exit(2);
  }
  console.log(`[seed] probing as user ${existing.id.slice(0, 8)} (handle="${existing.handle}")`);

  const bearer = forgeAuthenticatedJwt(env.SUPABASE_JWT_SECRET, existing.id);
  console.log(`[forge] bearer JWT issued (role=authenticated, sub=${existing.id.slice(0, 8)})`);

  const db = userScopedClient(env, bearer);
  console.log('[client] userScopedClient created — anon-key + bearer header');

  // (3) Raw rpc('get_user_self') — isolates SECURITY DEFINER layer.
  console.log('\n[raw probe — RPC] ctx.db.rpc("get_user_self"):');
  const rpcRes = await db.rpc('get_user_self');
  if (rpcRes.error) {
    console.log(`  ERROR: ${JSON.stringify(rpcRes.error)}`);
  } else if (!rpcRes.data) {
    console.log('  (returned null — function ran but no row matched auth.uid())');
  } else {
    const row = rpcRes.data as Record<string, unknown>;
    const publicCols = [
      'id',
      'handle',
      'display_name',
      'avatar_url',
      'current_ap',
      'tier_id',
      'is_bot',
    ];
    const privateCols = ['fingerprint', 'onboarded_at', 'notification_preferences', 'timezone'];
    console.log(`  PASS — returned ${Object.keys(row).length} columns`);
    console.log(
      `  public cols present:  ${publicCols.filter((c) => c in row).join(', ')} (expect 7)`,
    );
    console.log(
      `  private cols present: ${privateCols.filter((c) => c in row).join(', ')} (expect 4 — RPC bypasses column grant)`,
    );
  }

  // (4) Column-grant path — public subset via direct PostgREST SELECT.
  console.log(
    '\n[raw probe — column grant: public subset] from("users").select("id, handle, current_ap, tier_id, is_bot"):',
  );
  const pubRes = await db
    .from('users')
    .select('id, handle, current_ap, tier_id, is_bot')
    .eq('id', existing.id)
    .maybeSingle();
  if (pubRes.error) {
    console.log(`  ERROR: ${JSON.stringify(pubRes.error)}`);
  } else {
    console.log(`  PASS — returned ${pubRes.data ? Object.keys(pubRes.data).length : 0} columns`);
    console.log(`  ${JSON.stringify(pubRes.data, null, 2)}`);
  }

  // (5) Column-grant path — private columns must 42501.
  console.log(
    '\n[raw probe — column grant: private subset] from("users").select("fingerprint, notification_preferences"):',
  );
  const privRes = await db
    .from('users')
    .select('fingerprint, notification_preferences')
    .eq('id', existing.id)
    .maybeSingle();
  if (privRes.error) {
    console.log(`  EXPECTED DENY: ${privRes.error.code} — ${privRes.error.message}`);
  } else {
    console.log(`  UNEXPECTED PASS — private columns leaked: ${JSON.stringify(privRes.data)}`);
  }

  // (6) End-to-end via tRPC caller.
  console.log('\n[end-to-end] appRouter.createCaller(ctx).user.me():');
  const ctx: Context = {
    env,
    userId: existing.id,
    role: 'authenticated',
    db,
    bearerToken: bearer,
    redis: {} as Context['redis'],
  };

  let result: unknown = null;
  let trpcErr: unknown = null;
  try {
    result = await appRouter.createCaller(ctx).user.me();
    console.log(`  PASS — user.me returned the joined profile`);
    console.log(`  ${JSON.stringify(result, null, 2)}`);
  } catch (e) {
    trpcErr = e;
    console.log(`  user.me THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log('\n=== verdict ===');
  if (rpcRes.error || privRes.data || trpcErr || !result) {
    console.log('FAIL — at least one probe did not behave as expected.');
    process.exit(1);
  } else {
    console.log('PASS — rpc + column-grant + private-deny + tRPC user.me all behave as designed.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
