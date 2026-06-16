// Zod-validated runtime env for the workers process. Parse once at boot.

import { z } from 'zod';

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Direct Postgres connection. The LISTEN/NOTIFY client uses this.
  DATABASE_URL: z.string().url(),

  // Service-role Supabase client for the wallet UPDATE.
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Upstash Redis (REST). Used as the cross-process cost-ledger sink for
  // ai-fabric and as the durable store for matchmaking sorted sets when
  // the matchmaking router lands (PR #17).
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Privy. The flag must be 'true' AND both keys must be non-empty before
  // the listener actually calls the SDK; otherwise it logs a skip and
  // returns. Defense-in-depth so a misconfigured staging env can't half-
  // provision wallets.
  PRIVY_ENABLED: boolFromString.default(false),
  PRIVY_APP_ID: z.string().default(''),
  PRIVY_APP_SECRET: z.string().default(''),

  // VAPID — Web Push signing. All three vars must be non-empty before the
  // push_deliver handler actually dispatches; otherwise it logs a skip and
  // marks the row done with delivery_status='skipped_no_vapid'. Lets a dev
  // env without keys boot cleanly without dropping rows. Generated once via
  // `npx web-push generate-vapid-keys` and stored in env (NOT Postgres —
  // the private key never enters the database). Rotation: replace the pair,
  // redeploy workers; existing subscriptions fail next send with 401 and
  // soft-delete via the handler's disabled_reason='unauthorized' path.
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid env:\n${formatted}`);
  }
  return parsed.data;
}

export function privyReady(env: Env): boolean {
  return env.PRIVY_ENABLED && env.PRIVY_APP_ID.length > 0 && env.PRIVY_APP_SECRET.length > 0;
}

export function webPushReady(env: Env): boolean {
  return (
    env.VAPID_PUBLIC_KEY.length > 0 &&
    env.VAPID_PRIVATE_KEY.length > 0 &&
    env.VAPID_SUBJECT.length > 0
  );
}
