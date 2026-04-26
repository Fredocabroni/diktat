// Diktat workers entrypoint.
//
// Phase 3 (current): start the Privy provisioning LISTEN loop and wire
// the AI cost-ledger sink to Upstash Redis so cross-process spend
// aggregation works. Privy SDK calls are gated behind PRIVY_ENABLED.
//
// Phase 4+ adds durable retry queues (BullMQ + ioredis TCP) once a
// TCP-form REDIS_URL lands in the environment. Until then, the privy
// listener uses pg LISTEN/NOTIFY directly and the cost sink uses
// Upstash REST — both Redis-light, no broker required.

import { buildUpstashCostSink, hydrateLedgerFromSink, setCostSink } from '@diktat/ai-fabric';
import { Client as PgClient } from 'pg';

import { loadEnv, privyReady } from './env.js';
import { startPrivyProvisionListener, type PrivyWalletProvider } from './jobs/privy-provision.js';
import { buildLogger } from './logger.js';
import { buildRedis } from './redis.js';
import { buildServiceClient } from './supabase.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = buildLogger(env);

  logger.info({ event: 'workers.boot', nodeEnv: env.NODE_ENV });

  // Wire the cross-process AI cost ledger first so any subsequent
  // ai-fabric invocations land on the shared sink. Hydrate the
  // in-memory ledger from today's accumulated spend so a restarted
  // worker doesn't reset the budget.
  const redis = buildRedis(env);
  setCostSink(buildUpstashCostSink(redis));
  try {
    await hydrateLedgerFromSink();
    logger.info({ event: 'cost.ledger_hydrated' });
  } catch (err) {
    logger.warn({
      event: 'cost.ledger_hydrate_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }

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
