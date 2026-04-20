import { BudgetExceededError } from '@diktat/shared';
import type { CostRecord, LogSink, Task } from './types.js';
import { logCall } from './logging.js';

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
}
