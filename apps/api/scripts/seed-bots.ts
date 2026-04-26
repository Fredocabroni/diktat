// One-shot seed script for matchmaking bot opponents.
//
// Run after migration 0010 has been applied to a target Supabase project:
//
//   pnpm --filter=@diktat/api seed:bots
//
// The script is idempotent — re-runs skip handles that already exist.
// It uses the Supabase Auth Admin API (`auth.admin.createUser`) rather
// than direct INSERTs into auth.users, so it stays compatible across
// GoTrue schema bumps. Requires `SUPABASE_URL` and
// `SUPABASE_SERVICE_ROLE_KEY` in the process env.
//
// Each row triggers `handle_new_user`, which inserts the dependent
// public.users / streaks / wallets / ap_transactions rows. After that
// fires, the script overrides the auto-generated handle, pins
// current_ap to the seeded value, and sets is_bot=true. The signup
// audit row in ap_transactions is rewritten so the ledger matches the
// seeded balance.

import { randomBytes } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

interface BotSpec {
  readonly handle: string;
  readonly ap: number;
}

const BOTS: readonly BotSpec[] = [
  // Citizen (5)
  { handle: 'bot_calm_otter', ap: 55 },
  { handle: 'bot_glassy_ibis', ap: 65 },
  { handle: 'bot_quiet_finch', ap: 75 },
  { handle: 'bot_pale_robin', ap: 85 },
  { handle: 'bot_dim_thrush', ap: 95 },
  // Voter (8)
  { handle: 'bot_brisk_falcon', ap: 110 },
  { handle: 'bot_steady_lynx', ap: 135 },
  { handle: 'bot_warm_marten', ap: 160 },
  { handle: 'bot_eager_kite', ap: 185 },
  { handle: 'bot_curt_jay', ap: 210 },
  { handle: 'bot_drift_seal', ap: 235 },
  { handle: 'bot_swift_heron', ap: 260 },
  { handle: 'bot_keen_owl', ap: 285 },
  // Partisan (10)
  { handle: 'bot_tall_eagle', ap: 320 },
  { handle: 'bot_loud_raven', ap: 360 },
  { handle: 'bot_short_weasel', ap: 400 },
  { handle: 'bot_red_kestrel', ap: 440 },
  { handle: 'bot_blue_skua', ap: 480 },
  { handle: 'bot_lean_pika', ap: 520 },
  { handle: 'bot_stout_grouse', ap: 560 },
  { handle: 'bot_wide_oryx', ap: 600 },
  { handle: 'bot_jagged_shrike', ap: 660 },
  { handle: 'bot_thin_marmot', ap: 720 },
  // Operative (10)
  { handle: 'bot_arctic_fox', ap: 770 },
  { handle: 'bot_polar_loon', ap: 850 },
  { handle: 'bot_glade_stag', ap: 930 },
  { handle: 'bot_silt_lemur', ap: 1010 },
  { handle: 'bot_marsh_egret', ap: 1090 },
  { handle: 'bot_birch_lynx', ap: 1170 },
  { handle: 'bot_canyon_puma', ap: 1250 },
  { handle: 'bot_oasis_dik', ap: 1330 },
  { handle: 'bot_steppe_wolf', ap: 1410 },
  { handle: 'bot_tundra_seal', ap: 1480 },
  // Strategist (8)
  { handle: 'bot_iron_hawk', ap: 1550 },
  { handle: 'bot_silver_crane', ap: 1750 },
  { handle: 'bot_copper_owl', ap: 1950 },
  { handle: 'bot_jade_lark', ap: 2150 },
  { handle: 'bot_onyx_falcon', ap: 2350 },
  { handle: 'bot_pearl_swan', ap: 2550 },
  { handle: 'bot_amber_lynx', ap: 2750 },
  { handle: 'bot_obsidian_orca', ap: 2950 },
  // Tactician (5)
  { handle: 'bot_quartz_wolf', ap: 3100 },
  { handle: 'bot_basalt_bear', ap: 3700 },
  { handle: 'bot_granite_eagle', ap: 4300 },
  { handle: 'bot_marble_panther', ap: 4900 },
  { handle: 'bot_slate_orca', ap: 5400 },
  // Vanguard (3)
  { handle: 'bot_cobalt_kraken', ap: 6000 },
  { handle: 'bot_titan_phoenix', ap: 7500 },
  { handle: 'bot_aurora_leviathan', ap: 9500 },
  // Senator (1)
  { handle: 'bot_ascendant_archon', ap: 14000 },
];

interface UsersRow {
  id: string;
}

interface SeedResult {
  handle: string;
  status: 'created' | 'skipped' | 'failed';
  error?: string;
}

async function seedOne(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  spec: BotSpec,
): Promise<SeedResult> {
  // Idempotency: skip if a public.users row with this handle exists.
  const { data: existing, error: lookupErr } = (await supabase
    .from('users')
    .select('id')
    .eq('handle', spec.handle)
    .maybeSingle()) as { data: UsersRow | null; error: { message: string } | null };

  if (lookupErr) {
    return { handle: spec.handle, status: 'failed', error: lookupErr.message };
  }
  if (existing) {
    return { handle: spec.handle, status: 'skipped' };
  }

  const password = randomBytes(32).toString('hex');
  const { data: created, error: createErr } = (await supabase.auth.admin.createUser({
    email: `${spec.handle}@bots.diktat.local`,
    password,
    email_confirm: true,
    app_metadata: { is_bot: true, provider: 'seed' },
    user_metadata: { seed_origin: 'apps/api/scripts/seed-bots.ts' },
  })) as {
    data: { user: { id: string } | null };
    error: { message: string } | null;
  };

  if (createErr || !created?.user) {
    return {
      handle: spec.handle,
      status: 'failed',
      error: createErr?.message ?? 'createUser returned no user',
    };
  }

  const userId = created.user.id;

  // The handle_new_user trigger fired during createUser. Override the
  // generated handle, pin AP, mark as bot.
  const { error: updateUsersErr } = (await supabase
    .from('users')
    .update({
      handle: spec.handle,
      current_ap: spec.ap,
      is_bot: true,
    })
    .eq('id', userId)) as { error: { message: string } | null };
  if (updateUsersErr) {
    return { handle: spec.handle, status: 'failed', error: updateUsersErr.message };
  }

  // Realign the audit row written by the trigger so the ledger reflects
  // the seeded balance instead of the default 100.
  const { error: updateLedgerErr } = (await supabase
    .from('ap_transactions')
    .update({ delta: spec.ap, balance_after: spec.ap })
    .eq('idempotency_key', `signup_grant:${userId}`)) as { error: { message: string } | null };
  if (updateLedgerErr) {
    return { handle: spec.handle, status: 'failed', error: updateLedgerErr.message };
  }

  return { handle: spec.handle, status: 'created' };
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const results: SeedResult[] = [];
  for (const spec of BOTS) {
    const result = await seedOne(supabase, spec);
    results.push(result);
    const tag = result.status === 'failed' ? '✗' : result.status === 'created' ? '✓' : '·';
    console.info(
      `${tag} ${spec.handle.padEnd(24)} ap=${String(spec.ap).padStart(5)} ${result.status}${
        result.error ? ` (${result.error})` : ''
      }`,
    );
  }

  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  console.info(`\nseed-bots: ${created} created, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error('seed-bots: fatal:', err);
  process.exit(1);
});
