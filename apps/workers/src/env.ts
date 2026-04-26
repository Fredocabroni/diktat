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

  // Privy. The flag must be 'true' AND both keys must be non-empty before
  // the listener actually calls the SDK; otherwise it logs a skip and
  // returns. Defense-in-depth so a misconfigured staging env can't half-
  // provision wallets.
  PRIVY_ENABLED: boolFromString.default(false),
  PRIVY_APP_ID: z.string().default(''),
  PRIVY_APP_SECRET: z.string().default(''),
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
