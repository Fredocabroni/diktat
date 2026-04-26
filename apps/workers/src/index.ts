// Diktat workers entrypoint.
//
// Phase 3 (current): start the Privy provisioning LISTEN loop. The Privy
// SDK call is feature-flagged behind PRIVY_ENABLED — when off, signups
// still emit pg_notify but the listener logs a skip instead of calling
// the SDK. Wire to flip the flag once PRIVY_APP_ID + PRIVY_APP_SECRET
// land in the environment.
//
// Phase 4+ adds BullMQ + Redis-backed queues for matchmaking, battle
// settle, and trivia generation. Keep this file thin until then.

import { Client as PgClient } from 'pg';

import { loadEnv, privyReady } from './env.js';
import { startPrivyProvisionListener, type PrivyWalletProvider } from './jobs/privy-provision.js';
import { buildLogger } from './logger.js';
import { buildServiceClient } from './supabase.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = buildLogger(env);

  logger.info({ event: 'workers.boot', nodeEnv: env.NODE_ENV });

  const supabase = buildServiceClient(env);
  const privy = await buildPrivyProvider(env, logger);

  const listener = startPrivyProvisionListener({
    supabase,
    privy,
    logger,
    buildPgClient: () => new PgClient({ connectionString: env.DATABASE_URL }),
  });

  const shutdown = (signal: string): void => {
    logger.info({ event: 'workers.shutdown', signal });
    void listener.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function buildPrivyProvider(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof buildLogger>,
): Promise<PrivyWalletProvider | null> {
  if (!privyReady(env)) {
    logger.warn({
      event: 'privy.disabled',
      reason: env.PRIVY_ENABLED ? 'missing_keys' : 'flag_off',
    });
    return null;
  }

  // Lazy import so a workers dev install without keys doesn't have to
  // resolve the SDK at boot.
  const { PrivyClient } = await import('@privy-io/server-auth');
  const client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);

  return {
    async createSolanaWallet({ ownerExternalId }) {
      // The Privy SDK surface is in flux; we narrow it to our own
      // adapter shape. When the live SDK signature is finalized in
      // staging, the body of this method gets the real call. The
      // outer types stay stable so the rest of the listener doesn't
      // need to change.
      const wallet = await client.walletApi.create({
        chainType: 'solana',
        ownerId: ownerExternalId,
      });
      return {
        privyUserId: wallet.id,
        solanaAddress: wallet.address,
        evmAddress: null,
      };
    },
  };
}

void main().catch((err) => {
   
  console.error('[diktat-workers] fatal:', err);
  process.exit(1);
});
