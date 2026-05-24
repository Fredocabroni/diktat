// Periodic poll for `battles where status = 'live'` rows that don't
// have a runner attached locally. Spawns `runBattle` for each new
// arrival; the running map keeps a Set of in-flight battle ids so we
// don't double-spawn. Single-instance assumption — Phase 3.5 BullMQ
// migration moves this to a queue with distributed locks.

import type { invoke as fabricInvoke, ProviderEnv } from '@diktat/ai-fabric';

import type { Logger } from '../logger.js';
import type { ServiceClient } from '../supabase.js';
import { runBattle, type BattleRunnerDeps, type RunningBattle } from './battle-runner.js';
import {
  runOpenDebate,
  type OpenDebateRunnerDeps,
  type RunningOpenDebate,
} from './open-debate-runner.js';

export interface BattlePollerDeps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly runnerDeps?: Partial<Omit<BattleRunnerDeps, 'supabase' | 'logger'>>;
  /** Required for open_debate battles -- the runner calls debate_score. */
  readonly invoke?: typeof fabricInvoke;
  readonly providerEnv?: ProviderEnv;
  readonly openDebateRunnerDeps?: Partial<
    Omit<OpenDebateRunnerDeps, 'supabase' | 'logger' | 'invoke' | 'providerEnv'>
  >;
}

export interface BattlePollerHandle {
  scanOnce(): Promise<{ scanned: number; spawned: number }>;
  stop(): Promise<void>;
}

export function buildBattlePoller(deps: BattlePollerDeps): BattlePollerHandle {
  const running = new Map<string, RunningBattle | RunningOpenDebate>();

  async function scanOnce(): Promise<{ scanned: number; spawned: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = (await (deps.supabase as any)
      .from('battles')
      .select('id, status, mode')
      .eq('status', 'live')) as {
      data: { id: string; status: string; mode: string }[] | null;
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
      let handle: RunningBattle | RunningOpenDebate;
      if (row.mode === 'open_debate') {
        if (!deps.invoke) {
          deps.logger.warn({
            event: 'battle.poller.open_debate_skipped_no_invoke',
            battleId: row.id,
            message: 'open_debate battle live but poller has no ai-fabric invoke configured',
          });
          continue;
        }
        handle = runOpenDebate(row.id, {
          supabase: deps.supabase,
          logger: deps.logger,
          invoke: deps.invoke,
          ...(deps.providerEnv ? { providerEnv: deps.providerEnv } : {}),
          ...deps.openDebateRunnerDeps,
        });
      } else {
        handle = runBattle(row.id, {
          supabase: deps.supabase,
          logger: deps.logger,
          ...deps.runnerDeps,
        });
      }
      running.set(row.id, handle);
      spawned += 1;
      // When the lifecycle resolves, drop the handle so the next scan
      // can re-spawn if for some reason the same battle id reappears.
      // Failures inside the runner are logged there; we don't surface here.
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
