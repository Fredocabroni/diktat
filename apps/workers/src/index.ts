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
import { makeAlerter } from '@diktat/shared/alerts';
import { Client as PgClient } from 'pg';

import { loadEnv, privyReady, webPushReady, type Env } from './env.js';
import { buildBattlePoller } from './jobs/battle-poller.js';
import { MATCH_MODES, runMatchmakingTick } from './jobs/matchmake.js';
import { startPrivyProvisionListener, type PrivyWalletProvider } from './jobs/privy-provision.js';
import type { SendOutcome, WebPushSender } from './jobs/push-deliver.js';
import { buildDefaultHandlers, runSchedulerTick } from './jobs/scheduler.js';
import { buildLogger } from './logger.js';
import { buildRedis } from './redis.js';
import { buildServiceClient } from './supabase.js';

const MATCHMAKE_TICK_MS = 1_000;
const BATTLE_POLLER_TICK_MS = 5_000;
const SCHEDULER_TICK_MS = 60_000; // ~1 min -- a committed due-row fires within the next minute.

// Telegram alerter — constructed at module scope from RAW process.env (NOT the
// validated env) so it is available even when loadEnv() throws on a bad var, and
// so the fatal handlers below can alert on a boot crash. No-op when the token /
// chat id are unset. onFailure logs a coarse status only (never the token/url).
const alerter = makeAlerter({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  onFailure: ({ status, severity }) =>
    console.warn(JSON.stringify({ event: 'telegram_alert_failed', status, severity })),
});

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = buildLogger(env);

  logger.info({ event: 'workers.boot', nodeEnv: env.NODE_ENV });

  // 🟢 Positive boot confirmation, fired once right after env load. On a
  // never-before-deployed service a silent no-op and a healthy start look
  // identical; this proves the process came up AND the Telegram path works
  // end-to-end. Fire-and-forget (the process keeps running).
  void alerter.alert(
    'info',
    'workers booted',
    `pid ${process.pid} · ${env.NODE_ENV} · alerts=${alerter.enabled}`,
    { dedupKey: 'workers:boot' },
  );

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
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ event: 'matchmake.tick_failed', mode, message });
          void alerter.alert('error', 'matchmake tick failed', `${mode} · ${message}`, {
            dedupKey: `workers:tick:matchmake:${mode}`,
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
    // Forwarded into the in-process runners so a battle.runner.failed /
    // open_debate.tick_failed also 🔴-alerts (deduped per battle).
    runnerDeps: { alerter },
    openDebateRunnerDeps: { alerter },
  });
  let battlePollerBusy = false;
  const battlePollerInterval = setInterval(() => {
    if (battlePollerBusy) return;
    battlePollerBusy = true;
    battlePoller
      .scanOnce()
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ event: 'battle.poller.scan_failed', message });
        void alerter.alert('error', 'battle poller scan failed', message, {
          dedupKey: 'workers:tick:poller',
        });
      })
      .finally(() => {
        battlePollerBusy = false;
      });
  }, BATTLE_POLLER_TICK_MS);

  // Web-push sender. Lazily import the web-push library so dev envs
  // without VAPID keys don't have to resolve it at boot. When VAPID env
  // is unset the sender stays null and the push_deliver handler stamps
  // skipped_no_vapid on claimed rows (rather than letting them dead-letter
  // on missing credentials).
  const webPushSender = await buildVapidSender(env, logger);

  // Scheduler poll — drains public.scheduled_jobs rows emitted by pg_cron
  // and dispatches by job_type to the handler registry. push_deliver is
  // attached at boot via buildDefaultHandlers because its handler closes
  // over the VAPID sender; all other handlers are static module-level
  // exports off scheduler.ts.
  const schedulerHandlers = buildDefaultHandlers({ webPushSender });
  const schedulerWorkerId = `workers-${process.pid}-${Date.now()}`;
  let schedulerBusy = false;
  const schedulerInterval = setInterval(() => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    runSchedulerTick({
      supabase,
      logger,
      workerId: schedulerWorkerId,
      handlers: schedulerHandlers,
      // Forwarded to handlers that need them (PR 4.7 fact_check).
      invoke: fabricInvoke,
      providerEnv: debateProviderEnv,
      fetch: globalThis.fetch,
    })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ event: 'scheduler.tick_failed', message });
        void alerter.alert('error', 'scheduler tick failed', message, {
          dedupKey: 'workers:tick:scheduler',
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  }, SCHEDULER_TICK_MS);

  const SHUTDOWN_MAX_MS = 12_000;
  const shutdown = (signal: string): void => {
    logger.info({ event: 'workers.shutdown', signal });
    clearInterval(matchmakingInterval);
    clearInterval(battlePollerInterval);
    clearInterval(schedulerInterval);
    // battlePoller.stop() now DRAINS in-flight battles (applies AP before exit).
    // Force-exit if the drain itself hangs past the ceiling so a deploy can
    // never wedge on a stuck settlement.
    const force = setTimeout(() => {
      logger.warn({ event: 'workers.shutdown.forced', signal });
      process.exit(0);
    }, SHUTDOWN_MAX_MS);
    void Promise.all([battlePoller.stop(), listener.stop()]).finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
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

async function buildVapidSender(
  env: Env,
  logger: ReturnType<typeof buildLogger>,
): Promise<WebPushSender | null> {
  if (!webPushReady(env)) {
    logger.warn({
      event: 'push.deliver.disabled',
      reason: 'missing_vapid_env',
    });
    return null;
  }

  // Lazy import so a workers dev install without VAPID keys doesn't have
  // to resolve the web-push library at boot.
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  return {
    async send(sub, payload): Promise<SendOutcome> {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        return { kind: 'sent' };
      } catch (err) {
        const e = err as { statusCode?: number; body?: string; message?: string };
        const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
        // 404/410 are the spec-mandated "endpoint is permanently gone" codes.
        if (status === 404 || status === 410) return { kind: 'gone' };
        // 401/403 are signature/permission rejections. After a VAPID rotation,
        // existing endpoints fail with these and need re-subscription.
        if (status === 401 || status === 403) return { kind: 'unauthorized' };
        if (status === 413) return { kind: 'payload_too_large' };
        // Everything else (including network-level errors with status=0) is
        // treated as transient and lets the scheduler retry with backoff.
        return {
          kind: 'transient',
          statusCode: status,
          message: e.body ?? e.message ?? 'unknown',
        };
      }
    },
  };
}

// Fatal-path handler shared by boot failure + uncaught errors. AWAITS the
// Telegram POST before exit — a fire-and-forget alert would die with the
// process, so a boot crash would otherwise be silent. Includes pid + uptime so
// the <=5 restarts from restartPolicyMaxRetries are self-evidently one boot loop
// rather than byte-identical spam. In-memory dedup can't span restarts (state
// resets), so these are NOT deduped across processes by design — never-swallow
// is prioritized over never-repeat; the loop is bounded and self-terminates.
let fatalHandled = false;
async function handleFatal(event: string, err: unknown): Promise<void> {
  if (fatalHandled) process.exit(1);
  fatalHandled = true;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[diktat-workers] fatal (${event}):`, err);
  await alerter.alert(
    'error',
    'workers fatal',
    `${event} · pid ${process.pid} · up ${process.uptime().toFixed(1)}s · ${message}`,
  );
  process.exit(1);
}

process.on('uncaughtException', (err) => void handleFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => void handleFatal('unhandledRejection', reason));

void main().catch((err) => handleFatal('boot', err));
