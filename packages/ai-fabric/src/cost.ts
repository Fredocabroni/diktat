import { BudgetExceededError } from '@diktat/shared';
import type { CostRecord, LogSink, Task } from './types.js';
import { logCall } from './logging.js';
import type { CostSink } from './redis-cost-sink.js';

/**
 * Per-task daily caps. Sum equals the global ceiling exactly ($30/day).
 *
 * Allocation rationale:
 * - code_gen $8: most expensive (Opus 4.7 + extended thinking on coding work)
 * - debate_score $5: live battle scoring volume
 * - sourced_factcheck $4: long Perplexity Sonar contexts
 * - live_factcheck $4: Grok burst usage
 * - trivia_gen $3: batch generation, can throttle
 * - news_rank $2: Haiku is cheap; covers high request count
 * - clip_gen $2: Gemini 2.5 Pro
 * - x_post $1: low volume, short outputs
 * - fingerprint $1: incremental updates
 */
export const PER_TASK_CAPS_USD: Record<Task, number> = {
  code_gen: 8,
  debate_score: 5,
  sourced_factcheck: 4,
  live_factcheck: 4,
  trivia_gen: 3,
  news_rank: 2,
  clip_gen: 2,
  x_post: 1,
  fingerprint: 1,
};

/** $30/day hard ceiling — sum of per-task caps. */
export const GLOBAL_CAP_USD = Object.values(PER_TASK_CAPS_USD).reduce((a, b) => a + b, 0);

/** Warn-level alert threshold. */
export const ALERT_AT_USD = 22;

const ZERO_BY_TASK = (): Record<Task, number> => ({
  code_gen: 0,
  trivia_gen: 0,
  live_factcheck: 0,
  sourced_factcheck: 0,
  debate_score: 0,
  news_rank: 0,
  clip_gen: 0,
  x_post: 0,
  fingerprint: 0,
});

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const ledger: CostRecord = {
  utcDay: utcDayKey(new Date()),
  byTask: ZERO_BY_TASK(),
  total: 0,
};

let alertedThisDay = false;

// Optional cross-process observability sink (Upstash REST in production).
// When set, every recordSpend ALSO fires a non-blocking write to the
// sink. The in-memory ledger remains the authoritative gate for
// assertUnderCap — see redis-cost-sink.ts for the rationale.
let costSink: CostSink | null = null;

export function setCostSink(sink: CostSink | null): void {
  costSink = sink;
}

export function getCostSink(): CostSink | null {
  return costSink;
}

/** Resets the in-memory ledger if `now` lands on a new UTC day. */
export function resetIfNewUtcDay(now: Date): void {
  const key = utcDayKey(now);
  if (key !== ledger.utcDay) {
    ledger.utcDay = key;
    ledger.byTask = ZERO_BY_TASK();
    ledger.total = 0;
    alertedThisDay = false;
  }
}

/** Throws `BudgetExceededError` if recording `projectedUsd` for `task` would
 * push either the per-task cap or the global cap over its limit. */
export function assertUnderCap(task: Task, projectedUsd: number, now: Date = new Date()): void {
  resetIfNewUtcDay(now);
  const taskCap = PER_TASK_CAPS_USD[task];
  const taskAfter = ledger.byTask[task] + projectedUsd;
  if (taskAfter > taskCap) {
    throw new BudgetExceededError(task, taskAfter, taskCap);
  }
  const totalAfter = ledger.total + projectedUsd;
  if (totalAfter > GLOBAL_CAP_USD) {
    throw new BudgetExceededError(`global:${task}`, totalAfter, GLOBAL_CAP_USD);
  }
}

/** Add an actual measured spend after a successful call. */
export function recordSpend(
  task: Task,
  usd: number,
  opts: { now?: Date; sink?: LogSink; provider?: string; model?: string } = {},
): void {
  const now = opts.now ?? new Date();
  resetIfNewUtcDay(now);
  ledger.byTask[task] += usd;
  ledger.total += usd;
  if (!alertedThisDay && ledger.total >= ALERT_AT_USD) {
    alertedThisDay = true;
    logCall(
      {
        ts: now.toISOString(),
        level: 'warn',
        task,
        provider: (opts.provider as never) ?? 'anthropic',
        model: opts.model ?? 'n/a',
        usd: ledger.total,
        latencyMs: 0,
        status: 'ok',
        message: `[budget-alert] daily AI spend reached $${ledger.total.toFixed(2)} (alert threshold $${ALERT_AT_USD}, ceiling $${GLOBAL_CAP_USD})`,
      },
      opts.sink,
    );
  }
  // Fire-and-forget cross-process mirror. Failures here degrade
  // observability, never the caller's request — they're only logged.
  if (costSink !== null && usd > 0) {
    const utcDay = ledger.utcDay;
    void costSink.recordSpend(utcDay, task, usd).catch((err) => {
      logCall(
        {
          ts: now.toISOString(),
          level: 'warn',
          task,
          provider: 'redis' as never,
          model: 'cost-sink',
          usd: 0,
          latencyMs: 0,
          status: 'fail',
          message: 'cost sink write failed',
          error: err instanceof Error ? err.message : String(err),
        },
        opts.sink,
      );
    });
  }
}

/**
 * A thrown error carrying the USD a provider already billed before a
 * downstream failure (e.g. a structured-output parse error).
 */
interface BilledError {
  billedUsd?: number;
}

/**
 * Stamp the already-incurred USD onto an error so the fabric fail path can
 * still record it. Closes the gap where a call that reached the provider
 * (and was billed) but failed downstream recorded $0.
 */
export function stampBilledUsd(err: unknown, usd: number): unknown {
  if (err !== null && typeof err === 'object' && Number.isFinite(usd) && usd > 0) {
    (err as BilledError).billedUsd = usd;
  }
  return err;
}

/** Read back the USD stamped by `stampBilledUsd`, or 0 when absent. */
export function readBilledUsd(err: unknown): number {
  if (err !== null && typeof err === 'object' && 'billedUsd' in err) {
    const v = (err as BilledError).billedUsd;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * Hydrate the in-memory ledger from the configured cost sink. Call once
 * at process boot AFTER `setCostSink(...)` so a restarted worker picks
 * up the day's accumulated spend instead of starting at zero.
 *
 * No-op when no sink is configured.
 */
export async function hydrateLedgerFromSink(now: Date = new Date()): Promise<void> {
  if (costSink === null) return;
  const utcDay = utcDayKey(now);
  const snapshot = await costSink.loadDailySpend(utcDay);
  ledger.utcDay = utcDay;
  ledger.byTask = ZERO_BY_TASK();
  for (const t of Object.keys(snapshot.byTask) as Task[]) {
    const v = snapshot.byTask[t];
    if (typeof v === 'number') ledger.byTask[t] = v;
  }
  ledger.total = snapshot.total;
  alertedThisDay = ledger.total >= ALERT_AT_USD;
}

export function getDailySpend(): { byTask: Record<Task, number>; total: number; utcDay: string } {
  return {
    byTask: { ...ledger.byTask },
    total: ledger.total,
    utcDay: ledger.utcDay,
  };
}

/** Test-only reset. Not exported from the package barrel. */
export function __resetLedgerForTests(): void {
  ledger.utcDay = utcDayKey(new Date());
  ledger.byTask = ZERO_BY_TASK();
  ledger.total = 0;
  alertedThisDay = false;
  costSink = null;
}
