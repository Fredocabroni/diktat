// One-shot: recreate public.get_user_self() on dev with the round-2
// shape (explicit TABLE return). The migration file `20260618120000` is
// already tracked in supabase_migrations.schema_migrations on dev, so
// `supabase db push` is a no-op. This script applies the round-2 fix
// directly so the dev DB matches the PR's intended state. Production
// (when this branch eventually merges) will apply the migration fresh
// from main and get the corrected shape without needing this script.

import { Client } from 'pg';
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();

await pg.query('begin');

await pg.query('drop function if exists public.get_user_self()');

await pg.query(`
  create function public.get_user_self()
  returns table (
    id uuid,
    handle extensions.citext,
    display_name text,
    avatar_url text,
    current_ap integer,
    tier_id smallint,
    is_bot boolean,
    onboarded_at timestamptz,
    notification_preferences jsonb
  )
  language sql
  security definer
  set search_path = ''
  stable
  as $fn$
    select
      u.id,
      u.handle,
      u.display_name,
      u.avatar_url,
      u.current_ap,
      u.tier_id,
      u.is_bot,
      u.onboarded_at,
      u.notification_preferences
    from public.users u
    where u.id = auth.uid();
  $fn$
`);

await pg.query(`
  comment on function public.get_user_self() is
    'Self-only access to the callers users row, returning the explicit public column set + onboarded_at + notification_preferences. Excludes fingerprint, timezone, last_active_at, created_at, updated_at — those columns are structurally absent from the return type so a future router refactor cannot leak them. SECURITY DEFINER bypasses the column-level GRANT; the function body locks reads to auth.uid() so a caller cannot fetch another users row.'
`);

await pg.query('revoke all on function public.get_user_self() from public');
await pg.query('grant execute on function public.get_user_self() to authenticated');

await pg.query('commit');

console.log('get_user_self() recreated on dev with explicit-column return type.');

// Verify
const r = await pg.query(`
  select pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_user_self'
`);
console.log('\n=== current function definition on dev ===');
console.log(r.rows[0].def);

await pg.end();
