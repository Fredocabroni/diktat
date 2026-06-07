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

import {
  buildUpstashCostSink,
  hydrateLedgerFromSink,
  invoke as fabricInvoke,
  setCostSink,
  type ProviderEnv,
} from '@diktat/ai-fabric';
import { Client as PgClient } from 'pg';

import { loadEnv, privyReady } from './env.js';
import { buildBattlePoller } from './jobs/battle-poller.js';
import { MATCH_MODES, runMatchmakingTick } from './jobs/matchmake.js';
import { startPrivyProvisionListener, type PrivyWalletProvider } from './jobs/privy-provision.js';
import { defaultHandlers, runSchedulerTick } from './jobs/scheduler.js';
import { buildLogger } from './logger.js';
import { buildRedis } from './redis.js';
import { buildServiceClient } from './supabase.js';

const MATCHMAKE_TICK_MS = 1_000;
const BATTLE_POLLER_TICK_MS = 5_000;
const SCHEDULER_TICK_MS = 60_000; // ~1 min -- a committed due-row fires within the next minute.

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

  // Matchmaking polling loop — single-instance assumption keeps races
  // out of scope. Phase 3.5 BullMQ migration adds distributed locks.
  // Tick once per mode (trivia + open_debate). Open debate disables bot
  // fallback internally (V1 is human-vs-human).
  let matchmakingBusy = false;
  const matchmakingInterval = setInterval(() => {
    if (matchmakingBusy) return;
    matchmakingBusy = true;
    Promise.all(
      MATCH_MODES.map((mode) =>
        runMatchmakingTick({ redis, supabase, logger }, { mode }).catch((err) => {
          logger.error({
            event: 'matchmake.tick_failed',
            mode,
            message: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    ).finally(() => {
      matchmakingBusy = false;
    });
  }, MATCHMAKE_TICK_MS);

  // Battle poller — discovers status='live' battle rows (created by
  // the matchmaking tick above) and spawns the right in-process runner for
  // each by `battle.mode`. The open-debate runner calls `debate_score` via
  // the ai-fabric `invoke`. Single-instance ownership; Phase 3.5 BullMQ
  // migration adds distributed locks.
  const debateProviderEnv: ProviderEnv = {
    xaiAvailable: Boolean(process.env.XAI_API_KEY),
    perplexityAvailable: Boolean(process.env.PERPLEXITY_API_KEY),
  };
  const battlePoller = buildBattlePoller({
    supabase,
    logger,
    invoke: fabricInvoke,
    providerEnv: debateProviderEnv,
  });
  let battlePollerBusy = false;
  const battlePollerInterval = setInterval(() => {
    if (battlePollerBusy) return;
    battlePollerBusy = true;
    battlePoller
      .scanOnce()
      .catch((err) => {
        logger.error({
          event: 'battle.poller.scan_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        battlePollerBusy = false;
      });
  }, BATTLE_POLLER_TICK_MS);

  // Scheduler poll — drains public.scheduled_jobs rows emitted by pg_cron
  // and dispatches by job_type to the handler registry. This PR registers
  // 'heartbeat' only; feature PRs extend defaultHandlers with their own
  // job types (drop_publish in 4.2, risk_push in 4.4, etc.).
  const schedulerWorkerId = `workers-${process.pid}-${Date.now()}`;
  let schedulerBusy = false;
  const schedulerInterval = setInterval(() => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    runSchedulerTick({
      supabase,
      logger,
      workerId: schedulerWorkerId,
      handlers: defaultHandlers,
      // Forwarded to handlers that need them (PR 4.7 fact_check).
      invoke: fabricInvoke,
      providerEnv: debateProviderEnv,
      fetch: globalThis.fetch,
    })
      .catch((err) => {
        logger.error({
          event: 'scheduler.tick_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  }, SCHEDULER_TICK_MS);

  const shutdown = (signal: string): void => {
    logger.info({ event: 'workers.shutdown', signal });
    clearInterval(matchmakingInterval);
    clearInterval(battlePollerInterval);
    clearInterval(schedulerInterval);
    void Promise.all([battlePoller.stop(), listener.stop()]).finally(() => process.exit(0));
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
