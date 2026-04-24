// Privy custodial-wallet provisioning, async via Postgres LISTEN/NOTIFY.
//
// The auth.users insert trigger (handle_new_user, migration 0009) fires
//   pg_notify('privy_provision', new.id::text)
// for every non-bot signup. This module starts a dedicated pg client that
// subscribes to that channel and provisions a Solana custodial wallet via
// the Privy SDK, then UPDATEs `public.wallets` with the resulting ids.
//
// Behaviour
// ---------
//   - Idempotent on user_id: a second NOTIFY for the same user is a no-op
//     once `wallets.privy_user_id` is non-null.
//   - Feature-flagged: when `PRIVY_ENABLED` is off (or keys are missing)
//     the handler logs a skip and returns. No SDK call, no wallet UPDATE.
//   - Retry policy: backoff [250, 500, 1000, 2000, 4000] ms around the
//     Privy SDK call. On final failure the handler logs `privy.failed`
//     at error level and RETURNS — it never throws upward, so one bad
//     signup cannot kill the listener loop.
//   - Listener resilience: on pg client error/disconnect the listener
//     reconnects with backoff [1, 2, 4, 8, 16, 30] s.
//
// BullMQ is intentionally NOT used in this PR. The pure pg LISTEN
// approach has no Redis dependency, which lets PR #13 land before the
// workers infra (PR #14, gated on Upstash provisioning).

import type { Logger } from '../logger.js';
import type { ServiceClient } from '../supabase.js';

// Subset of @privy-io/server-auth we actually depend on. Adapter at the
// boot site narrows the real client to this shape so tests can pass a
// fake without touching the SDK.
export interface PrivyWalletProvider {
  createSolanaWallet(opts: { ownerExternalId: string }): Promise<{
    privyUserId: string;
    solanaAddress: string;
    evmAddress: string | null;
  }>;
}

// Minimal pg client surface used by the listener. Mirrors `pg.Client` but
// loose enough that the real client and a test fake both fit. The real
// client's connect()/end() resolve to itself; we discard the value.
export interface PgListenClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'notification', cb: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  removeAllListeners(): unknown;
}

export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

export interface HandlerDeps {
  supabase: ServiceClient;
  privy: PrivyWalletProvider | null;
  logger: Logger;
  sleep?: SleepFn;
}

export interface HandleResult {
  status: 'provisioned' | 'skipped' | 'failed';
  reason?: 'flag_disabled' | 'already_provisioned' | 'retries_exhausted' | 'wallet_missing';
}

interface WalletShellRow {
  user_id: string;
  privy_user_id: string | null;
}

/**
 * Process one provision request. Pure async function — caller (the
 * listener) holds no critical state across it. Never throws.
 */
export async function handlePrivyProvision(
  userId: string,
  deps: HandlerDeps,
): Promise<HandleResult> {
  const { supabase, privy, logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  // Flag check first — cheaper than a DB roundtrip.
  if (privy === null) {
    logger.info({ event: 'privy.skipped', userId, reason: 'flag_disabled' });
    return { status: 'skipped', reason: 'flag_disabled' };
  }

  // Idempotency check. Read the wallet shell that handle_new_user already
  // inserted. If there's no row the trigger never fired — bail.
  const walletsTable = supabase.from('wallets');
  const { data, error } = (await walletsTable
    .select('user_id, privy_user_id')
    .eq('user_id', userId)
    .maybeSingle()) as { data: WalletShellRow | null; error: { message: string } | null };

  if (error) {
    logger.error({ event: 'privy.read_failed', userId, message: error.message });
    return { status: 'failed', reason: 'wallet_missing' };
  }

  if (data === null) {
    logger.warn({ event: 'privy.skipped', userId, reason: 'wallet_missing' });
    return { status: 'skipped', reason: 'wallet_missing' };
  }

  if (data.privy_user_id !== null) {
    logger.info({ event: 'privy.skipped', userId, reason: 'already_provisioned' });
    return { status: 'skipped', reason: 'already_provisioned' };
  }

  // Call the Privy SDK with backoff. Errors from createSolanaWallet are
  // assumed transient (network, 429, 5xx) — if a permanent failure (auth,
  // bad input) sneaks through it'll exhaust retries and fall through to
  // the failed branch, which is the right outcome (no half-state).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      const wallet = await privy.createSolanaWallet({ ownerExternalId: userId });
      const update = (await supabase
        .from('wallets')
        .update({
          privy_user_id: wallet.privyUserId,
          solana_address: wallet.solanaAddress,
          evm_address: wallet.evmAddress,
          external_wallet_id: wallet.solanaAddress,
        })
        .eq('user_id', userId)) as { error: { message: string } | null };

      if (update.error) {
        logger.error({
          event: 'privy.update_failed',
          userId,
          message: update.error.message,
        });
        return { status: 'failed', reason: 'retries_exhausted' };
      }

      logger.info({
        event: 'privy.provisioned',
        userId,
        privyUserId: wallet.privyUserId,
      });
      return { status: 'provisioned' };
    } catch (err) {
      lastError = err;
      const backoff = RETRY_BACKOFF_MS[attempt] ?? 0;
      logger.warn({
        event: 'privy.retry',
        userId,
        attempt: attempt + 1,
        backoffMs: backoff,
        message: err instanceof Error ? err.message : String(err),
      });
      if (attempt < RETRY_BACKOFF_MS.length - 1) {
        await sleep(backoff);
      }
    }
  }

  logger.error({
    event: 'privy.failed',
    userId,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return { status: 'failed', reason: 'retries_exhausted' };
}

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export interface ListenerDeps extends HandlerDeps {
  buildPgClient: () => PgListenClient;
}

export interface ListenerHandle {
  stop: () => Promise<void>;
}

/**
 * Start the LISTEN loop. Returns a handle whose `stop()` ends the pg
 * client cleanly — wire that to SIGTERM/SIGINT so containers shut down
 * without dropping mid-flight provisioning.
 */
export function startPrivyProvisionListener(deps: ListenerDeps): ListenerHandle {
  const { logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  let stopped = false;
  let currentClient: PgListenClient | null = null;

  async function loop(): Promise<void> {
    let reconnectAttempt = 0;
    while (!stopped) {
      const client = deps.buildPgClient();
      currentClient = client;
      try {
        await client.connect();
        await client.query('LISTEN privy_provision');
        logger.info({ event: 'privy.listener_started' });
        reconnectAttempt = 0;

        client.on('notification', (msg) => {
          if (msg.channel !== 'privy_provision') return;
          const userId = msg.payload?.trim();
          if (!userId) return;
          void handlePrivyProvision(userId, deps);
        });

        // Wait until the client errors or stop() is called. We resolve via
        // an error listener; if the client stays healthy this Promise hangs
        // until stop() ends the client (which raises an error event).
        await new Promise<void>((resolve) => {
          client.on('error', (err) => {
            logger.warn({ event: 'privy.listener_error', message: err.message });
            resolve();
          });
        });
      } catch (err) {
        logger.warn({
          event: 'privy.listener_connect_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          client.removeAllListeners();
          await client.end();
        } catch {
          // Swallow cleanup errors — we're either reconnecting or shutting down.
        }
        currentClient = null;
      }

      if (stopped) break;
      const backoff =
        RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;
      logger.warn({ event: 'privy.listener_reconnect', backoffMs: backoff });
      await sleep(backoff);
      reconnectAttempt += 1;
    }
    logger.info({ event: 'privy.listener_stopped' });
  }

  void loop();

  return {
    async stop() {
      stopped = true;
      if (currentClient) {
        try {
          currentClient.removeAllListeners();
          await currentClient.end();
        } catch {
          // Same swallow as above.
        }
      }
    },
  };
}
