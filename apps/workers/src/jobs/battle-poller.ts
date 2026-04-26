// Periodic poll for `battles where status = 'live'` rows that don't
// have a runner attached locally. Spawns `runBattle` for each new
// arrival; the running map keeps a Set of in-flight battle ids so we
// don't double-spawn. Single-instance assumption — Phase 3.5 BullMQ
// migration moves this to a queue with distributed locks.

import type { Logger } from '../logger.js';
import type { ServiceClient } from '../supabase.js';
import { runBattle, type BattleRunnerDeps, type RunningBattle } from './battle-runner.js';

export interface BattlePollerDeps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly runnerDeps?: Partial<Omit<BattleRunnerDeps, 'supabase' | 'logger'>>;
}

export interface BattlePollerHandle {
  scanOnce(): Promise<{ scanned: number; spawned: number }>;
  stop(): Promise<void>;
}

export function buildBattlePoller(deps: BattlePollerDeps): BattlePollerHandle {
  const running = new Map<string, RunningBattle>();

  async function scanOnce(): Promise<{ scanned: number; spawned: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = (await (deps.supabase as any)
      .from('battles')
      .select('id, status')
      .eq('status', 'live')) as {
      data: { id: string; status: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      deps.logger.warn({
        event: 'battle.poller.fetch_failed',
        message: error.message,
      });
      return { scanned: 0, spawned: 0 };
    }

    const live = data ?? [];
    let spawned = 0;
    for (const row of live) {
      if (running.has(row.id)) continue;
      const handle = runBattle(row.id, {
        supabase: deps.supabase,
        logger: deps.logger,
        ...deps.runnerDeps,
      });
      running.set(row.id, handle);
      spawned += 1;
      // When the lifecycle resolves, drop the handle so the next scan
      // can re-spawn if for some reason the same battle id reappears.
      // Failures inside runBattle are logged there; we don't surface here.
      void handle.done.finally(() => running.delete(row.id));
    }

    return { scanned: live.length, spawned };
  }

  async function stop(): Promise<void> {
    for (const handle of running.values()) handle.stop();
    running.clear();
  }

  return { scanOnce, stop };
}
