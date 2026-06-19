// Probe whether `feed.list` actually works at runtime against real
// PostgREST with a real authenticated bearer JWT — the production-shape
// access path. Unit tests use `fakeDb` and never exercise this layer.
//
// What it does:
//   1. Uses serviceRoleClient to flip one news_topics row to
//      is_drop=true, drop_at=now(), is_block_exhausted=false. The
//      service-role bypasses RLS + has table grants, so this seed
//      step is independent of the question we're probing.
//   2. Forges a `role: authenticated` JWT with the project's
//      SUPABASE_JWT_SECRET — same shape Supabase Auth issues.
//   3. Builds a userScopedClient with that bearer (the EXACT
//      production-shape construction from apps/api/src/supabase.ts:19).
//   4. Builds a tRPC Context manually (mirroring buildContext) and
//      invokes `appRouter.createCaller(ctx).feed.list()` — the
//      production read path end-to-end.
//   5. Reports whether the call returns the seeded row OR throws
//      a PostgREST 42501 / other error.
//   6. Restores the row to its original state.
//
// Run:
//   (cd apps/api && set -a; . /Users/tyrionlannister/diktat/.env.local; \
//    set +a; pnpm exec tsx scripts/probe-feed-list-runtime.ts)

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

  // Step 1 — seed a live Drop via service-role.
  const sr = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const snap = await sr
    .from('news_topics')
    .select('id, is_drop, drop_at, is_block_exhausted')
    .order('created_at', { ascending: false });
  if (snap.error || !snap.data || snap.data.length === 0) {
    console.error('Cannot snapshot rows:', snap.error);
    process.exit(2);
  }
  const target = snap.data[0]!;
  console.log(`[seed] flipping row ${target.id.slice(0, 8)} → is_drop=true, drop_at=now()`);

  const now = new Date().toISOString();
  const seed = await sr
    .from('news_topics')
    .update({ is_drop: true, drop_at: now, is_block_exhausted: false })
    .eq('id', target.id);
  if (seed.error) {
    console.error('Seed failed:', seed.error);
    process.exit(3);
  }

  // Step 2 — forge a real authenticated JWT.
  const bearer = forgeAuthenticatedJwt(env.SUPABASE_JWT_SECRET, target.id);
  console.log(`[forge] bearer JWT issued (role=authenticated, sub=${target.id.slice(0, 8)})`);

  // Step 3 — build userScopedClient (production-shape).
  const db = userScopedClient(env, bearer);
  console.log('[client] userScopedClient created — anon-key + bearer header');

  // Step 4 — invoke feed.list through the real tRPC caller.
  const ctx: Context = {
    env,
    userId: target.id,
    role: 'authenticated',
    db,
    bearerToken: bearer,
    redis: {} as Context['redis'],
    clientIpCidr: 'probe-feed-list',
  };

  let result: { topics: unknown[] } | null = null;
  let probeErr: unknown = null;
  try {
    result = (await appRouter.createCaller(ctx).feed.list()) as { topics: unknown[] };
    console.log(`[probe] feed.list returned ${result.topics.length} row(s)`);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    probeErr = e;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[probe] feed.list THREW: ${msg}`);
  }

  // Step 5 — also probe the raw PostgREST call shape independently
  // (no tRPC wrapping) so we can isolate whether the failure is at the
  // network/auth layer vs. in our router code.
  console.log('\n[raw probe] direct REST call from userScopedClient:');
  const raw = await db
    .from('news_topics')
    .select('id, is_drop, drop_at')
    .eq('is_drop', true)
    .lte('drop_at', new Date().toISOString())
    .order('drop_at', { ascending: false })
    .limit(1);
  if (raw.error) {
    console.log(`  ERROR: ${JSON.stringify(raw.error)}`);
  } else {
    console.log(`  data rows: ${raw.data?.length}`);
    console.log(`  ${JSON.stringify(raw.data, null, 2)}`);
  }

  // Step 6 — restore.
  console.log(`\n[restore] reverting row ${target.id.slice(0, 8)} to its snapshot`);
  await sr
    .from('news_topics')
    .update({
      is_drop: target.is_drop,
      drop_at: target.drop_at,
      is_block_exhausted: target.is_block_exhausted,
    })
    .eq('id', target.id);

  // Final verdict.
  console.log('\n=== verdict ===');
  if (result && result.topics.length === 1) {
    console.log('PASS — feed.list returned the seeded Drop end-to-end.');
  } else if (raw.error) {
    console.log(`FAIL — userScopedClient PostgREST call errored: ${JSON.stringify(raw.error)}`);
  } else if (probeErr) {
    console.log(`FAIL — tRPC layer threw: ${probeErr instanceof Error ? probeErr.message : probeErr}`);
  } else {
    console.log('FAIL — call returned 0 rows despite a live seeded row.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
